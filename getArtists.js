require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Groq = require("groq-sdk");

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;
const groqApiKey = process.env.GROQ_API_KEY; 

if (!mongoUri || !googleApiKey || !googleCx || !groqApiKey) {
    throw new Error('Faltan variables de entorno críticas.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const groq = new Groq({ apiKey: groqApiKey });

const aiPromptTemplate = (content) => `
    Actúa como mi asistente de investigación experto en flamenco, "El Duende". Tu única misión es encontrar eventos de flamenco en el siguiente contenido HTML y devolverlos en un formato JSON específico.

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
    
    Contenido a analizar:
    ${content}
`;

/**
 * Filtra los eventos asegurándose de que la fecha sea igual o posterior a la fecha actual.
 * @param {string} dateString La fecha del evento en formato 'YYYY-MM-DD'.
 * @returns {boolean} Verdadero si el evento es futuro o de hoy, falso si es del pasado.
 */
function isFutureEvent(dateString) {
    if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        console.warn(`      -> ⚠️ Formato de fecha inválido '${dateString}'. Se descarta el evento.`);
        return false;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = new Date(dateString);
    eventDate.setHours(0, 0, 0, 0);
    return eventDate >= today;
}

async function extractEventDataFromURL(url, retries = 3) {
    console.log(`     -> 🤖 Llamando a la IA (Groq) para analizar la URL: ${url}`);
    
    try {
        const pageResponse = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 10000 
        });
        const content = pageResponse.data;
        
        const prompt = aiPromptTemplate(content);
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "llama3-8b-8192", // Modelo de Groq
            temperature: 0,
        });

        const text = chatCompletion.choices[0]?.message?.content || '';

        const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
        
        if (jsonMatch && jsonMatch[1]) {
            const jsonString = jsonMatch[1];
            // Aquí añadimos la URL al JSON
            const events = JSON.parse(jsonString);
            if (Array.isArray(events)) {
                return events.map(event => ({ ...event, sourceUrl: url }));
            }
            return [];
        } else {
            console.error('      -> ⚠️ La IA no devolvió un bloque JSON válido.');
            return [];
        }
    } catch (error) {
        if (error.message.includes('429 Too Many Requests') && retries > 0) {
            console.warn(`      -> ⏳ ERROR 429: Límite de cuota de Groq excedido. Pausando 60 segundos y reintentando...`);
            await delay(60000); 
            return extractEventDataFromURL(url, retries - 1);
        } else {
            console.error(`      -> ❌ Error al llamar a la API de Groq para la URL ${url}:`, error.message);
            return [];
        }
    }
}


async function runScraper() {
    console.log("Iniciando ojeador con lógica de búsqueda y extractor con IA (Groq)...");
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
                            eventsFromAI.forEach(event => {
                                if (isFutureEvent(event.date)) {
                                    allNewEvents.push(event);
                                } else {
                                    console.log(`      -> ❌ Descartado: El evento '${event.name}' es del pasado.`);
                                }
                            });
                        }
                    }
                    // Pausa de 10 segundos entre cada llamada a la IA
                    console.log('      -> Pausando 10 segundos para respetar la cuota de la API...');
                    await delay(10000); 
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