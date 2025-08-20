// /api/orchestrator.js - Versión Final Mejorada
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

const BATCH_SIZE = 15; // Límite de artistas a procesar por ejecución.

// --- PROMPT PARA GEMINI (Refinado) ---
const eventExtractionPrompt = (artistName, url, content) => {
    const currentYear = new Date().getFullYear();

    return `
    Tu tarea es actuar como un asistente experto en extracción de datos de eventos musicales.
    Analiza el siguiente contenido de la URL "${url}" para encontrar los próximos conciertos o actuaciones en vivo del artista "${artistName}".

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

// --- CAMBIO CLAVE: Lógica de búsqueda en cascada y por categorías ---
const searchQueries = (artistName) => ({
    entradas: [
        `"${artistName}" "entradas" "concierto" site:ticketmaster.es OR site:elcorteingles.es OR site:entradas.com OR site:dice.fm OR site:seetickets.com`
    ],
    redes_sociales: [
        `"${artistName}" "eventos" site:facebook.com`,
        `"${artistName}" "próximos conciertos" site:instagram.com`,
        `"${artistName}" "agenda" site:twitter.com`
    ],
    descubrimiento: [
        `"${artistName}" "agenda" "conciertos"`,
        `"${artistName}" "fechas gira"`,
        `"${artistName}" "próximos eventos"`
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

        for (const artist of artistsToSearch) {
            console.log(`\n---------------------------------\n🎤 Procesando a: ${artist.name}`);
            let eventsFoundForArtist = [];
            const queriesForArtist = searchQueries(artist.name);

            // --- Bucle de búsqueda en cascada ---
            for (const category of ['entradas', 'redes_sociales', 'descubrimiento']) {
                console.log(`   -> Iniciando búsqueda por categoría: "${category}"`);

                const currentQueries = queriesForArtist[category];
                for (const query of currentQueries) {
                    try {
                        const searchRes = await customsearch.cse.list({ cx: customSearchEngineId, q: query, auth: googleApiKey, num: 3 });
                        const searchResults = searchRes.data.items || [];
                        console.log(`   -> Resultados de búsqueda para "${query}": ${searchResults.length}`);

                        for (const result of searchResults) {
                            try {
                                const url = result.link;
                                const domainsToAvoid = ['tripadvisor', 'gamefaqs', 'repec', 'wikipedia'];
                                // Eliminamos de la lista de evitación las redes sociales, ya que ahora las buscamos intencionadamente
                                if (domainsToAvoid.some(domain => url.includes(domain))) {
                                    console.log(`   -> 🟡 URL descartada por dominio no relevante: ${url}`);
                                    continue;
                                }

                                console.log(`   -> Analizando URL: ${url}`);
                                const pageResponse = await axios.get(url, { timeout: 8000 });
                                const cleanedContent = cleanHtmlForGemini(pageResponse.data);

                                if (cleanedContent.length < 100) {
                                    console.log("   -> Contenido demasiado corto, saltando.");
                                    continue;
                                }

                                const prompt = eventExtractionPrompt(artist.name, result.link, cleanedContent);
                                const geminiResult = await geminiModel.generateContent(prompt);
                                const responseText = geminiResult.response.text();

                                const eventsFromPage = JSON.parse(responseText);

                                if (eventsFromPage.length > 0) {
                                    console.log(`   ✨ La IA encontró ${eventsFromPage.length} posibles eventos.`);
                                    eventsFoundForArtist.push(...eventsFromPage.map(e => ({ ...e, artist: artist.name })));
                                }
                            } catch (error) {
                                console.error(`   ❌ Error procesando ${result.link}: ${error.message.substring(0, 150)}`);
                            }
                        }
                    } catch (searchError) {
                        console.error(`   ❌ Error en la búsqueda de Google para "${query}": ${searchError.message}`);
                    }
                }
                // Si encontramos al menos un evento en la categoría actual, salimos del bucle de categorías
                if (eventsFoundForArtist.length > 0) {
                    console.log(`   ✅ Se encontraron eventos en la categoría "${category}". Pasando al siguiente artista.`);
                    break;
                }
            }
            // --- Fin del bucle de búsqueda en cascada ---

            let newEventsForArtistCount = 0;
            if (eventsFoundForArtist.length > 0) {
                const uniqueEvents = [...new Map(eventsFoundForArtist.map(e => [e.date + e.venue, e])).values()];

                for (const event of uniqueEvents) {
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
                            contentStatus: 'pending',
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        };
                        await eventsCollection.insertOne(newEventDoc);
                        newEventsForArtistCount++;
                    }
                }
            }
            console.log(`   ✅ Procesamiento para ${artist.name} finalizado. Nuevos eventos añadidos: ${newEventsForArtistCount}`);
            totalNewEventsCount += newEventsForArtistCount;

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
