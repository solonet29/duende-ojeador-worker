require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;
const geminiApiKey = process.env.GEMINI_API_KEY; // Tu clave de Gemini

if (!mongoUri || !googleApiKey || !googleCx || !geminiApiKey) {
    throw new Error('Faltan variables de entorno críticas.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const aiPromptTemplate = (url) => `
    Actúa como mi asistente de investigación experto en flamenco, "El Duende". Tu única misión para hoy es encontrar eventos de flamenco en esta URL y devolverlos en un formato JSON específico.

    Foco de la Búsqueda:
    Busca conciertos, recitales y festivales de flamenco que ocurran en el futuro (después de hoy). No incluyas eventos del pasado.

    Reglas de Formato y Procesamiento (MUY IMPORTANTE):
    Tu respuesta debe ser únicamente un bloque de código JSON dentro de un bloque de markdown. No incluyas ningún otro texto.
    El formato de cada evento en el array JSON debe ser exactamente este:
    [
        {
            "id": "string",
            "name": "string",
            "artist": "string",
            "description": "string",
            "date": "string (YYYY-MM-DD)",
            "time": "string (HH:MM)",
            "venue": "string",
            "city": "string",
            "country": "string",
            "provincia": "string",
            "verified": "boolean",
            "sourceUrl": "string"
        }
    ]

    Regla Anti-Duplicados: Si encuentras el mismo evento (mismos artistas, misma fecha y misma hora) en varias fuentes, incluye únicamente el que provenga de la fuente más fiable. Por ejemplo, un enlace a ticketmaster.es o al teatrodelamaestranza.com es más fiable que un enlace a un blog.

    Si no encuentras ningún evento nuevo, devuelve un array vacío [].
    La URL a analizar es: ${url}
`;

async function extractEventDataFromURL(url) {
    console.log(`     -> 🤖 Llamando a la IA para analizar la URL: ${url}`);
    
    try {
        const prompt = aiPromptTemplate(url);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // Extraer el bloque de código JSON del texto
        const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
        
        if (jsonMatch && jsonMatch[1]) {
            const jsonString = jsonMatch[1];
            return JSON.parse(jsonString);
        } else {
            console.error('      -> ⚠️ La IA no devolvió un bloque JSON válido.');
            return [];
        }
    } catch (error) {
        console.error(`      -> ❌ Error al llamar a la API de Gemini para la URL ${url}:`, error.message);
        return [];
    }
}


async function runScraper() {
    console.log("Iniciando ojeador con lógica de búsqueda y extractor con IA...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; 
    let queryCount = 0;

    try {
        await client.connect();
        const database = client.db('DuendeDB');
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        const artistsToSearch = await artistsCollection.find({}).limit(5).toArray(); 
        console.log(`Encontrados ${artistsToSearch.length} artistas en la base de datos para buscar.`);

        for (const artist of artistsToSearch) {
            console.log(`-------------------------------------------`);
            console.log(`(Consulta #${queryCount + 1}) Buscando eventos para: ${artist.name}`);
            
            try {
                const searchQuery = `concierto flamenco "${artist.name}" 2025`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                
                queryCount++; 
                const response = await axios.get(searchUrl);
                const searchResults = response.data.items || [];
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                
                for (const result of searchResults) {
                    const title = result.title.toLowerCase();
                    const snippet = result.snippet.toLowerCase();
                    const artistNameLower = artist.name.toLowerCase();

                    if (title.includes(artistNameLower) || snippet.includes(artistNameLower)) {
                        const eventsFromAI = await extractEventDataFromURL(result.link);
                        if (eventsFromAI && eventsFromAI.length > 0) {
                            allNewEvents.push(...eventsFromAI);
                        }
                    }
                    await delay(1000); // Pausa entre llamadas a la IA para evitar límites de tasa
                }
            } catch (error) {
                 if (error.response && error.response.status === 429) {
                    console.error(`   -> ❌ ERROR 429: Cuota de Google excedida...`);
                    await delay(60000);
                 } else {
                    console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
                 }
            }
            await delay(1500); // Pausa entre artistas
        }

        console.log(`-------------------------------------------`);
        console.log(`Proceso de búsqueda finalizado. Total de eventos nuevos encontrados: ${allNewEvents.length}`);
        
        if (allNewEvents.length > 0) {
            console.log("Guardando eventos encontrados en la colección temporal de la base de datos...");
            const tempCollection = database.collection('temp_scraped_events');
            await tempCollection.deleteMany({}); 
            await tempCollection.insertMany(allNewEvents);
            console.log(`✅ ${allNewEvents.length} eventos guardados con éxito en la colección 'temp_scraped_events'.`);
        } else {
            console.log("No se encontraron eventos nuevos en esta ejecución.");
        }

    } catch (error) {
        console.error("Ha ocurrido un error fatal en el proceso principal:", error);
    } finally {
        await client.close();
        console.log("Conexión con la base de datos cerrada.");
    }
}

runScraper();