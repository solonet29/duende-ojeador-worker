// /api/orchestrator.js - Versión Final y Optimizada
// Misión: Encontrar y procesar eventos de flamenco para artistas existentes.

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
const eventsCollectionName = 'events';

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

// --- AJUSTE CLAVE: Reducción del lote para evitar timeouts en Vercel ---
const BATCH_SIZE = 8;

// --- PROMPT PARA GEMINI (Optimizado para Flamenco) ---
const eventExtractionPrompt = (artistName, url, content) => {
    const currentYear = new Date().getFullYear();

    return `
    Tu tarea es actuar como un asistente experto en extracción de datos de eventos de flamenco.
    Analiza el siguiente contenido de la URL "${url}" para encontrar los próximos conciertos o actuaciones en vivo del artista "${artistName}".

    **REGLA ADICIONAL CLAVE:**
    - Extrae **únicamente** eventos que estén claramente relacionados con el mundo del flamenco. Si no se menciona explícitamente el flamenco, el cante, el baile, la guitarra flamenca, o términos similares, descarta el evento.

    El año de referencia es ${currentYear}. Extrae únicamente eventos que ocurran en ${currentYear} o en años posteriores.

    Sigue estas REGLAS AL PIE DE LA LETRA:
    1.  **Formato de Salida Obligatorio**: Tu respuesta DEBE ser un array JSON, incluso si no encuentras eventos (en cuyo caso, devuelve un array vacío: []). No incluyas texto explicativo, comentarios o markdown antes o después del JSON.
    2.  **Esquema del Objeto Evento**: Cada objeto en el array debe seguir esta estructura exacta:
        {
          "name": "Nombre del Evento (si no se especifica, usa el nombre del artista)",
          "description": "Descripción breve y relevante del evento. Máximo 150 caracteres.",
          "date": "YYYY-MM-DD",
          "time": "HH:MM (formato 24h, si no se especifica, usa '00:00')",
          "venue": "Nombre del recinto o lugar del evento",
          "city": "Ciudad del evento",
          "country": "País del evento",
          "sourceUrl": "${url}"
        }
    3.  **Fidelidad y Relevancia de los Datos**:
        - No inventes información. Si un campo no está claramente presente en el texto (por ejemplo, la hora), usa el valor por defecto indicado en el esquema o un string vacío.
        - Ignora categóricamente eventos pasados, talleres, clases magistrales, retransmisiones online o simples menciones que no constituyan un evento futuro concreto y localizable.
        - Asegúrate de que la fecha extraída es completa (día, mes y año). Si solo se menciona el mes, descarta el evento para evitar imprecisiones.

    Contenido a analizar:
    ${content}
`;
};

function cleanHtmlForGemini(html) {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, aside').remove();
    return $('body').text().replace(/\s\s+/g, ' ').trim().substring(0, 15000);
}

// --- Lógica de búsqueda en cascada y por categorías ---
const searchQueries = (artistName) => ({
    redes_sociales: [
        `"${artistName}" "eventos" site:facebook.com`,
        `"${artistName}" "próximos conciertos" site:instagram.com`,
        `"${artistName}" "agenda" site:twitter.com`
    ],
    descubrimiento: [
        `"${artistName}" "agenda" "conciertos"`,
        `"${artistName}" "fechas gira"`,
        `"${artistName}" "próximos eventos"`
    ],
    entradas: [
        `"${artistName}" "entradas" "concierto" site:ticketmaster.es OR site:elcorteingles.es OR site:entradas.com OR site:dice.fm OR site:seetickets.com`
    ]
});

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

        const artistsToSearch = await artistsCollection
            .find({})
            .sort({ lastScrapedAt: 1 })
            .limit(BATCH_SIZE)
            .toArray();

        if (artistsToSearch.length === 0) {
            console.log("📪 No hay artistas que necesiten ser procesados.");
            return;
        }
        console.log(`🔍 Lote de ${artistsToSearch.length} artistas obtenido. Empezando procesamiento...`);

        const eventsToInsert = [];

        const processUrl = async (url, artistName) => {
            try {
                const domainsToAvoid = ['tripadvisor', 'gamefaqs', 'repec', 'wikipedia'];
                if (domainsToAvoid.some(domain => url.includes(domain))) {
                    console.log(`   -> 🟡 URL descartada por dominio no relevante: ${url}`);
                    return [];
                }

                console.log(`   -> Analizando URL: ${url}`);
                const pageResponse = await axios.get(url, { timeout: 8000 });
                const cleanedContent = cleanHtmlForGemini(pageResponse.data);

                if (cleanedContent.length < 100) {
                    console.log("   -> Contenido demasiado corto, saltando.");
                    return [];
                }

                const prompt = eventExtractionPrompt(artistName, url, cleanedContent);
                const geminiResult = await geminiModel.generateContent(prompt);
                const responseText = geminiResult.response.text();
                const eventsFromPage = JSON.parse(responseText);

                if (eventsFromPage.length > 0) {
                    console.log(`   ✨ La IA encontró ${eventsFromPage.length} posibles eventos en ${url}.`);
                }
                return eventsFromPage.map(e => ({ ...e, artist: artistName }));
            } catch (error) {
                console.error(`   ❌ Error procesando ${url}: ${error.message.substring(0, 150)}`);
                return [];
            }
        };

        for (const artist of artistsToSearch) {
            console.log(`
---------------------------------
🎤 Procesando a: ${artist.name}`);
            console.time(`[TIMER] Procesamiento para ${artist.name}`);
            let eventsFoundForArtist = [];
            const queriesForArtist = searchQueries(artist.name);
            let urlsToProcess = new Set();

            for (const category of ['redes_sociales', 'descubrimiento', 'entradas']) {
                console.log(`   -> Iniciando búsqueda por categoría: "${category}"`);
                const currentQueries = queriesForArtist[category];
                for (const query of currentQueries) {
                    try {
                        const searchRes = await customsearch.cse.list({ cx: customSearchEngineId, q: query, auth: googleApiKey, num: 3 });
                        const searchResults = searchRes.data.items || [];
                        console.log(`   -> Resultados de búsqueda para "${query}": ${searchResults.length}`);
                        searchResults.forEach(result => urlsToProcess.add(result.link));
                    } catch (searchError) {
                        console.error(`   ❌ Error en la búsqueda de Google para "${query}": ${searchError.message}`);
                    }
                }
            }

            if (urlsToProcess.size > 0) {
                const processingPromises = Array.from(urlsToProcess).map(url => processUrl(url, artist.name));
                const results = await Promise.all(processingPromises);
                eventsFoundForArtist = results.flat();
            }

            if (eventsFoundForArtist.length > 0) {
                console.log(`
🕵️‍♂️ Preparando eventos para inserción. Eventos brutos encontrados: ${eventsFoundForArtist.length}`);

                const uniqueEvents = [...new Map(eventsFoundForArtist.map(e => [e.date + e.venue, e])).values()];

                console.log(`Eventos únicos después del filtrado: ${uniqueEvents.length}`);

                for (const event of uniqueEvents) {
                    if (!event.name || !event.date || !event.venue) {
                        console.log(`   ⚠️ Evento omitido por datos incompletos:`, event);
                        continue;
                    }

                    console.log("   Buscando duplicado para:", event.artist, event.venue, event.date);
                    const existingEvent = await eventsCollection.findOne({
                        artist: event.artist,
                        venue: event.venue,
                        date: event.date
                    });

                    if (!existingEvent) {
                        const newEventDoc = {
                            ...event,
                            id: `evt-${event.artist.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${event.date}`,
                            verified: false,
                            contentStatus: 'pending',
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        };
                        eventsToInsert.push(newEventDoc);
                        console.log(`   ✅ Evento nuevo preparado para inserción: ${newEventDoc.name}`);
                    } else {
                        console.log(`   🟡 Evento duplicado, omitido: ${event.name}`);
                    }
                }
            }

            await artistsCollection.updateOne(
                { _id: artist._id },
                { $set: { lastScrapedAt: new Date() } }
            );
            console.timeEnd(`[TIMER] Procesamiento para ${artist.name}`);
        }

        // Inserción masiva al final del proceso
        if (eventsToInsert.length > 0) {
            await eventsCollection.insertMany(eventsToInsert);
            totalNewEventsCount = eventsToInsert.length;
            console.log(`\n🎉 Inserción masiva completada. Total de nuevos eventos añadidos: ${totalNewEventsCount}.`);
        } else {
            console.log("\n📪 No se encontraron nuevos eventos para añadir en esta ejecución.");
        }

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
