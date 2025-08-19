// api/orchestrator.js
// Reemplaza a findEvents.js y processArtist.js con un único endpoint robusto.
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

// --- Configuración ---
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';
const eventsCollectionName = 'events';

const googleApiKey = process.env.GOOGLE_API_KEY;
const customSearchEngineId = process.env.CUSTOM_SEARCH_ENGINE_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;

const customsearch = google.customsearch('v1');
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const BATCH_SIZE = 5; // Procesar 5 artistas por ejecución para no exceder timeouts

// --- Lógica de Limpieza y Extracción con IA ---

function cleanHtmlForGemini(html) {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, aside, form').remove();
    return $('body').text().replace(/\s\s+/g, ' ').trim().substring(0, 15000);
}

function eventExtractionPrompt(artistName, pageContent) {
    return `
    Analiza el siguiente contenido de una página web y extrae CUALQUIER evento o concierto del artista "${artistName}".
    Devuelve los resultados como un array de objetos JSON. Cada objeto debe tener la siguiente estructura:
    {
      "eventName": "Nombre del evento o gira (si se menciona)",
      "artistName": "${artistName}",
      "date": "Fecha del evento en formato ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ). Si no hay hora, usa el mediodía. Si no hay fecha, déjalo null.",
      "venue": "Lugar o recinto del evento",
      "city": "Ciudad",
      "country": "País",
      "ticketUrl": "URL directa para comprar entradas (si la encuentras)"
    }

    REGLAS IMPORTANTES:
    1.  Extrae solo eventos futuros. Ignora fechas pasadas.
    2.  Si no encuentras ningún evento, devuelve un array vacío: [].
    3.  No inventes datos. Si un campo no está disponible, déjalo en null.
    4.  El resultado DEBE ser un JSON válido.

    Contenido a analizar:
    ${pageContent}
    `;
}


// --- Lógica Principal del Orquestador ---

async function findAndProcessEvents() {
    console.log(`🚀 Orquestador iniciado. Buscando lote de ${BATCH_SIZE} artistas.`);
    const client = new MongoClient(mongoUri);
    let processedArtists = 0;
    let totalNewEvents = 0;

    try {
        await client.connect();
        const db = client.db(dbName);
        const artistsCollection = db.collection(artistsCollectionName);
        const eventsCollection = db.collection(eventsCollectionName);
        console.log("✅ Conectado a MongoDB.");

        // 1. Obtener un lote de artistas que no han sido revisados recientemente
        const artistsToSearch = await artistsCollection.find({
            status: 'approved' // O el estado que uses para artistas activos
        }).sort({ lastScrapedAt: 1 }).limit(BATCH_SIZE).toArray();

        if (artistsToSearch.length === 0) {
            console.log("📪 No hay artistas que necesiten ser procesados ahora mismo.");
            return;
        }

        console.log(`🔍 Lote de ${artistsToSearch.length} artistas obtenido. Empezando procesamiento...`);

        for (const artist of artistsToSearch) {
            console.log(`
---------------------------------
🎤 Procesando a: ${artist.name}`);
            const searchQueries = [
                `"${artist.name}" "conciertos" "gira" "entradas"`,
                `"${artist.name}" "agenda" "actuaciones"`
            ];

            let foundEvents = [];

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

                            const prompt = eventExtractionPrompt(artist.name, cleanedContent);
                            const geminiResult = await geminiModel.generateContent(prompt);
                            const responseText = geminiResult.response.text();
                            const eventsFromPage = JSON.parse(responseText);

                            if (eventsFromPage.length > 0) {
                                console.log(`   ✨ La IA encontró ${eventsFromPage.length} posibles eventos.`);
                                foundEvents.push(...eventsFromPage);
                            }
                        } catch (error) {
                            console.error(`   ❌ Error procesando ${result.link}: ${error.message.substring(0, 100)}`);
                        }
                    }
                } catch (searchError) {
                     console.error(`   ❌ Error en la búsqueda de Google para "${query}": ${searchError.message}`);
                }
            }

            // 2. Insertar eventos nuevos en la base de datos, evitando duplicados
            if (foundEvents.length > 0) {
                const uniqueEvents = [...new Map(foundEvents.map(e => [e.date + e.venue + e.city, e])).values()];
                for (const event of uniqueEvents) {
                    // Comprobar si un evento muy similar ya existe
                    const existingEvent = await eventsCollection.findOne({
                        artistName: event.artistName,
                        venue: event.venue,
                        city: event.city,
                        date: event.date ? new Date(event.date) : null
                    });

                    if (!existingEvent) {
                        const newEvent = {
                            ...event,
                            artistId: artist._id,
                            date: event.date ? new Date(event.date) : null,
                            status: 'published',
                            createdAt: new Date(),
                            updatedAt: new Date()
                        };
                        await eventsCollection.insertOne(newEvent);
                        totalNewEvents++;
                    }
                }
            }
             console.log(`   ✅ Eventos encontrados para ${artist.name}: ${foundEvents.length}. Nuevos añadidos: ${totalNewEvents}`);


            // 3. Actualizar la fecha de 'lastScrapedAt' para el artista
            await artistsCollection.updateOne(
                { _id: artist._id },
                { $set: { lastScrapedAt: new Date() } }
            );
            processedArtists++;
        }

        console.log(`
🎉 Orquestador finalizado. Artistas procesados: ${processedArtists}. Total de nuevos eventos añadidos: ${totalNewEvents}.`);

    } catch (error) {
        console.error("💥 Error fatal en el Orquestador:", error);
    } finally {
        await client.close();
        console.log("🔚 Conexión con MongoDB cerrada.");
    }
}

// Endpoint para Vercel
module.exports = async (req, res) => {
    // Puedes añadir una clave secreta para proteger el endpoint si quieres
    // const { authorization } = req.headers;
    // if (authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    //     return res.status(401).send('Unauthorized');
    // }

    try {
        await findAndProcessEvents();
        res.status(200).send('Orquestador ejecutado con éxito.');
    } catch (error) {
        res.status(500).send(`Error en el orquestador: ${error.message}`);
    }
};
