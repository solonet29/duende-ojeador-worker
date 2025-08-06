require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;

if (!mongoUri || !googleApiKey || !googleCx) {
    throw new Error('Faltan variables de entorno críticas.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Aquí definiremos tu prompt experto en flamenco.
const aiPromptTemplate = (url) => `
    Actúa como mi asistente de investigación experto en flamenco, "El Duende". Tu única misión para hoy es encontrar eventos de flamenco en esta URL y devolverlos en un formato JSON específico.

    Foco de la Búsqueda:
    Busca nuevos conciertos, recitales y festivales de flamenco.

    Reglas de Formato y Procesamiento (MUY IMPORTANTE):
    Tu respuesta debe ser únicamente un bloque de código JSON dentro de un bloque de markdown. No incluyas ningún otro texto.
    El formato de cada evento en el array JSON debe ser exactamente este:
    {
        "id": "Un identificador único (usa el artista, ciudad y fecha en formato slug)",
        "name": "El nombre oficial del espectáculo.",
        "artist": "El artista o artistas principales.",
        "description": "Una breve descripción del evento.",
        "date": "La fecha en formato YYYY-MM-DD.",
        "time": "La hora en formato HH:MM.",
        "venue": "El nombre del lugar.",
        "city": "La ciudad.",
        "country": "El país.",
        "provincia": "La provincia",
        "verified": "true si la fuente es fiable (web oficial, vendedor de entradas), false si es un blog o foro.",
        "sourceUrl": "${url}"
    }

    Regla Anti-Duplicados: Si encuentras el mismo evento (mismos artistas, misma fecha y misma hora) en varias fuentes, incluye únicamente el que provenga de la fuente más fiable. Por ejemplo, un enlace a ticketmaster.es o al teatrodelamaestranza.com es más fiable que un enlace a un blog.

    Si no encuentras ningún evento nuevo, devuelve un array vacío [].
`;

// Esta función es un placeholder para la futura integración con la API de IA.
async function extractEventDataFromURL(url) {
    console.log(`     -> 🤖 Llamando a la IA para analizar la URL: ${url}`);
    
    // TODO: Aquí irá el código real para llamar a la API de Gemini, GPT-4, etc.
    // Usaremos el prompt aiPromptTemplate(url) para hacer la petición.
    // Por ahora, devolveremos un evento ficticio para no romper el flujo.
    
    return [
        {
            id: 'evt-ai-test-1',
            name: 'Evento de prueba por IA',
            artist: 'Antonio Reyes',
            description: 'Este evento fue extraído con éxito por la IA.',
            date: '2025-10-20',
            time: '21:00',
            venue: 'Teatro de Prueba',
            city: 'Madrid',
            country: 'España',
            provincia: 'Madrid',
            verified: true,
            sourceUrl: url
        }
    ];
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
                
                const parsedEvents = []; 
                
                for (const result of searchResults) {
                    const title = result.title.toLowerCase();
                    const snippet = result.snippet.toLowerCase();
                    const artistNameLower = artist.name.toLowerCase();

                    const textToSearch = title + " " + snippet;

                    if (textToSearch.includes(artistNameLower)) {
                        // Aquí llamamos a la nueva función de extracción con IA
                        const eventsFromAI = await extractEventDataFromURL(result.link);
                        if (eventsFromAI && eventsFromAI.length > 0) {
                            parsedEvents.push(...eventsFromAI);
                        }
                    }
                }
                
                if (parsedEvents.length > 0) {
                    console.log(` -> ¡Éxito! Se han parseado ${parsedEvents.length} eventos nuevos para este artista.`);
                    allNewEvents.push(...parsedEvents);
                }

            } catch (error) {
                 if (error.response && error.response.status === 429) {
                    console.error(`   -> ❌ ERROR 429: Cuota de Google excedida...`);
                    await delay(60000);
                 } else {
                    console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
                 }
            }
            await delay(1500);
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