// /api/orchestrator.js - Versión Final
// Misión: Encontrar eventos para artistas existentes de forma rotativa.

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');

// --- Configuración ---
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';
const eventsCollectionName = 'events'; // Colección final de eventos

const googleApiKey = process.env.GOOGLE_API_KEY;
const customSearchEngineId = process.env.GOOGLE_CX;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!mongoUri || !geminiApiKey || !googleApiKey || !customSearchEngineId) {
    throw new Error('Faltan variables de entorno críticas.');
}

// --- Inicialización de Servicios ---
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', generationConfig: { responseMimeType: 'application/json' } });
const customsearch = google.customsearch('v1');

const BATCH_SIZE = 15; // Límite de artistas a procesar por ejecución.

// --- Prompt para Gemini (Refinado) ---
const eventExtractionPrompt = (artistName, url, content) => `
    Analiza el siguiente contenido de la URL "${url}" y extrae eventos futuros del artista "${artistName}".
    Devuelve un array JSON de objetos.
    REGLAS ESTRICTAS:
    1. Tu respuesta DEBE ser exclusivamente un array JSON válido.
    2. El formato de cada objeto es: { "name": "Nombre del Evento", "description": "Descripción breve", "date": "YYYY-MM-DD", "time": "HH:MM", "venue": "Lugar", "city": "Ciudad", "country": "País", "sourceUrl": "${url}" }.
    3. Extrae solo eventos futuros. Ignora fechas pasadas.
    4. Si no encuentras eventos, devuelve un array vacío: [].
    Contenido a analizar:
    ${content}
`;

function cleanHtmlForGemini(html) {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, aside').remove();
    return $('body').text().replace(/\s\s+/g, ' ').trim().substring(0, 15000);
}

// --- Flujo Principal del Orquestador ---
async function findAndProcessEvents() {
    console.log(`🚀 Orquestador iniciado. Buscando lote de ${BATCH_SIZE} artistas.`);
    const client = new MongoClient(mongoUri);
    let totalNewEventsCount = 0;

    try {
        await client.connect();
        const db = client.db(dbName);
        const artistsCollection = db.collection(artistsCollectionName);
        const eventsCollection = db.collection(eventsCollectionName);
        console.log("✅ Conectado a MongoDB.");

        // --- CAMBIO: Consulta de artistas simplificada y enfocada en la rotación ---
        const artistsToSearch = await artistsCollection
            .find({})
            .sort({ lastScrapedAt: 1 }) // Ordena por fecha: los más antiguos y los nuevos (null) primero
            .limit(BATCH_SIZE)
            .toArray();

        if (artistsToSearch.length === 0) {
            console.log("📪 No hay artistas que necesiten ser procesados.");
            return;
        }
        console.log(`🔍 Lote de ${artistsToSearch.length} artistas obtenido. Empezando procesamiento...`);

        for (const artist of artistsToSearch) {
            console.log(`\n---------------------------------\n🎤 Procesando a: ${artist.name}`);
            let eventsFoundForArtist = [];
            const searchQueries = [
                `concierto flamenco "${artist.name}" 2025`,
                `"${artist.name}" entradas gira`
            ];

            for (const query of searchQueries) {
                try {
                    const searchRes = await customsearch.cse.list({ cx: customSearchEngineId, q: query, auth: googleApiKey, num: 3 });
                    const searchResults = searchRes.data.items || [];
                    for (const result of searchResults) {
                        try {
                            console.log(`   -> Analizando URL: ${result.link}`);
                            const pageResponse = await axios.get(result.link, { timeout: 8000 });
                            const cleanedContent = cleanHtmlForGemini(pageResponse.data);

                            if (cleanedContent.length < 100) continue;

                            const prompt = eventExtractionPrompt(artist.name, result.link, cleanedContent);
                            const geminiResult = await geminiModel.generateContent(prompt);
                            const responseText = geminiResult.response.text();
                            const eventsFromPage = JSON.parse(responseText);

                            if (eventsFromPage.length > 0) {
                                console.log(`   ✨ La IA encontró ${eventsFromPage.length} posibles eventos.`);
                                eventsFoundForArtist.push(...eventsFromPage.map(e => ({ ...e, artist: artist.name })));
                            }
                        } catch (error) {
                            console.error(`   ❌ Error procesando ${result.link}: ${error.message.substring(0, 150)}`);
                        }
                    }
                } catch (searchError) {
                    console.error(`   ❌ Error en la búsqueda de Google para "${query}": ${searchError.message}`);
                }
            }

            let newEventsForArtistCount = 0;
            if (eventsFoundForArtist.length > 0) {
                const uniqueEvents = [...new Map(eventsFoundForArtist.map(e => [e.date + e.venue, e])).values()];

                for (const event of uniqueEvents) {
                    // --- CAMBIO: Comprobación de duplicados más robusta ---
                    const existingEvent = await eventsCollection.findOne({
                        artist: event.artist,
                        venue: event.venue,
                        date: event.date
                    });

                    if (!existingEvent && event.date) {
                        const newEventDoc = {
                            ...event,
                            id: `evt-${event.artist.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${event.date}`,
                            verified: false,
                            contentStatus: 'pending', // Listo para el Creador de Contenidos
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        };
                        await eventsCollection.insertOne(newEventDoc);
                        newEventsForArtistCount++;
                    }
                }
            }
            console.log(`   ✅ Procesamiento para ${artist.name} finalizado. Nuevos eventos añadidos: ${newEventsForArtistCount}`);
            totalNewEventsCount += newEventsForArtistCount;

            // Actualizar la fecha de 'lastScrapedAt' para el artista
            await artistsCollection.updateOne(
                { _id: artist._id },
                { $set: { lastScrapedAt: new Date() } }
            );
        }
        console.log(`\n🎉 Orquestador finalizado. Total de nuevos eventos añadidos en esta ejecución: ${totalNewEventsCount}.`);

    } catch (error) {
        console.error("💥 Error fatal en el Orquestador:", error);
    } finally {
        await client.close();
        console.log("🔚 Conexión con MongoDB cerrada.");
    }
}

// Endpoint para Vercel
module.exports = async (req, res) => {
    try {
        await findAndProcessEvents();
        res.status(200).send('Orquestador ejecutado con éxito.');
    } catch (error) {
        res.status(500).send(`Error en el orquestador: ${error.message}`);
    }
};
