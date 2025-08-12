/**
 * Script autónomo para el proyecto "Duende Finder".
 * Se encarga de buscar eventos de artistas, identificar sus roles,
 * ingestar nuevos artistas en la base de datos y guardar los eventos encontrados.
 *
 * Fase 1: Búsqueda de eventos.
 * Fase 2: Enriquecimiento de la base de datos de artistas.
 */

// 1. Módulos y dependencias
require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 2. Configuración
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';
const tempCollectionName = 'temp_scraped_events';

// Configuración de las APIs
const googleApiKey = process.env.GOOGLE_API_KEY; // Corregido: Quitado el .env extra
const googleCx = process.env.GOOGLE_CX;
const geminiApiKey = process.env.GEMINI_API_KEY;

// Verificación de variables de entorno
if (!mongoUri || !googleApiKey || !googleCx || !geminiApiKey) {
    throw new Error('Faltan variables de entorno críticas. Revisa tu archivo .env');
}

// Inicialización de Gemini (Modelo PRO para máxima fiabilidad)
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-pro-latest',
    generationConfig: {
        responseMimeType: 'application/json'
    }
});

// Mapeo de ciudades a provincias
const cityToProvinceMap = {
    'málaga': 'Málaga', 'madrid': 'Madrid', 'barcelona': 'Barcelona', 'sevilla': 'Sevilla',
    'córdoba': 'Córdoba', 'granada': 'Granada', 'jerez de la frontera': 'Cádiz',
    'cádiz': 'Cádiz', 'valencia': 'Valencia', 'sotogrande': 'Cádiz',
};

// Funciones de utilidad
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isFutureEvent(dateString) {
    if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = new Date(dateString);
    return eventDate >= today;
}

function cleanHtmlAndExtractText(html) {
    const $ = cheerio.load(html);
    $('script, style, noscript, header, footer, nav, aside').remove();
    const text = $('body').text() || "";
    const cleanedText = text.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    const MAX_LENGTH = 15000;
    return cleanedText.substring(0, MAX_LENGTH);
}

// Plantillas de prompt para la IA
// --- PROMPT MEJORADO para incluir el ROL del artista ---
const unifiedPromptTemplate = (url, content) => `
    Eres un bot experto en extraer datos de eventos de flamenco.
    Tu única tarea es analizar el texto de la URL "${url}" y devolver un array JSON con los eventos futuros que encuentres.
    REGLAS ESTRICTAS:
    1. Tu respuesta DEBE ser exclusivamente un array JSON válido. No incluyas texto, comentarios, ni la palabra "json".
    2. Incluye solo eventos futuros (posteriores a la fecha de hoy).
    3. El formato de cada objeto debe ser: { "id": "slug-unico", "name": "Nombre", "artist": { "name": "Artista Principal", "role": "ROL DEL ARTISTA (e.g., Cantaor, Bailaor, Guitarrista)" }, "description": "...", "date": "YYYY-MM-DD", "time": "HH:MM", "venue": "Lugar", "city": "Ciudad", "provincia": "Provincia", "country": "País", "verified": false, "sourceUrl": "${url}" }.
    4. Asegúrate de que todos los strings dentro del JSON están correctamente escapados.
    5. Si no encuentras ningún evento futuro válido, devuelve un array JSON vacío: [].
    Texto a analizar:
    ${content}
`;


const correctionPromptTemplate = (brokenJson, errorMessage) => `
    El siguiente texto no es un JSON válido. El error es: "${errorMessage}".
    Por favor, arréglalo y devuelve exclusivamente el array JSON corregido y válido. No añadas ningún otro texto.
    Texto a corregir:
    ${brokenJson}
`;

// Lógica de extracción con IA (con auto-corrección)
async function extractEventDataFromURL(url, retries = 3) {
    console.log(`     -> 🤖 Analizando con IA (modelo Pro): ${url}`);
    try {
        const pageResponse = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 10000
        });
        const cleanedContent = cleanHtmlAndExtractText(pageResponse.data);
        const prompt = unifiedPromptTemplate(url, cleanedContent);
        console.log(`       -> 🤖 Llamando a Gemini para extraer datos de eventos...`);

        const result = await model.generateContent(prompt);
        let responseText = result.response.text();
        let events = [];
        try {
            events = JSON.parse(responseText);
        } catch (e) {
            console.warn(`     -> ⚠️ El JSON inicial no es válido (${e.message}). Intentando auto-corrección...`);
            const correctionPrompt = correctionPromptTemplate(responseText, e.message);
            const correctedResult = await model.generateContent(correctionPrompt);
            responseText = correctedResult.response.text();
            try {
                events = JSON.parse(responseText);
                console.log("     -> ✨ Auto-corrección exitosa.");
            } catch (finalError) {
                console.error("     -> ❌ Fallo final al parsear JSON incluso después de corregir:", finalError.message);
            }
        }
        if (events.length > 0) {
            console.log(`     -> ✅ Éxito: La IA ha extraído ${events.length} evento(s).`);
            return events.map(event => {
                const mappedEvent = { ...event };
                if (mappedEvent.country && mappedEvent.country.toLowerCase() === 'españa' && mappedEvent.city && !mappedEvent.provincia) {
                    mappedEvent.provincia = cityToProvinceMap[mappedEvent.city.toLowerCase()] || null;
                }
                return mappedEvent;
            });
        }
        return [];
    } catch (error) {
        if ((error.message.includes('429') || (error.response && error.response.status === 429)) && retries > 0) {
            console.warn(`     -> ⏳ ERROR 429: Cuota de Gemini excedida. Pausando 60 segundos...`);
            await delay(60000);
            return extractEventDataFromURL(url, retries - 1);
        } else {
            console.error(`     -> ❌ Error en el proceso de IA para ${url}:`, error.message);
            return [];
        }
    }
}


// ==================================================================
// --- INICIO: NUEVA FUNCIÓN DE INGESTA DE ARTISTAS ---
// ==================================================================

/**
 * Busca artistas en los eventos recién escrapeados y los añade a la colección principal si no existen.
 * @param {Array} scrapedEvents - Array de eventos de la colección temporal.
 * @param {Db} db - Instancia de la base de datos de MongoDB.
 */
async function findAndIngestNewArtists(scrapedEvents, db) {
    console.log('-------------------------------------------');
    console.log('Fase 2: Iniciando el enriquecimiento de la base de datos de artistas.');
    const artistsCollection = db.collection(artistsCollectionName);
    let newArtistsCount = 0;

    // Usamos un Map para procesar cada artista solo una vez, incluso si aparece en múltiples eventos del mismo scrape.
    const uniqueArtists = new Map();
    for (const event of scrapedEvents) {
        // Verificamos que el artista sea un objeto con 'name' y 'role'
        if (event.artist && typeof event.artist === 'object' && event.artist.name && event.artist.role) {
            const artistKey = event.artist.name.toLowerCase();
            if (!uniqueArtists.has(artistKey)) {
                uniqueArtists.set(artistKey, {
                    name: event.artist.name.trim(),
                    role: event.artist.role.trim()
                });
            }
        }
    }

    if (uniqueArtists.size === 0) {
        console.log('No se encontraron nuevos artistas con rol identificado en este lote de eventos.');
        return;
    }

    console.log(`Se han identificado ${uniqueArtists.size} artistas únicos para procesar.`);

    for (const artist of uniqueArtists.values()) {
        try {
            const existingArtist = await artistsCollection.findOne({
                name: { $regex: new RegExp(`^${artist.name}$`, 'i') }
            });

            if (!existingArtist) {
                const newArtistDocument = {
                    name: artist.name,
                    mainRole: artist.role,
                    genres: ['Flamenco'],
                    status: 'pending_review',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    lastScrapedAt: null // Lo ponemos a null para que sea candidato a búsqueda pronto
                };

                await artistsCollection.insertOne(newArtistDocument);
                newArtistsCount++;
                console.log(`✅ Nuevo artista añadido a la BD: ${artist.name} (${artist.role})`);
            } else {
                console.log(`- Artista ya existente, omitiendo: ${artist.name}`);
            }
        } catch (error) {
            console.error(`Error procesando al artista ${artist.name}:`, error);
        }
    }

    console.log(`🎉 Proceso de ingesta de artistas finalizado. Se añadieron ${newArtistsCount} nuevos artistas.`);
}

// ==================================================================
// --- FIN: NUEVA FUNCIÓN DE INGESTA DE ARTISTAS ---
// ==================================================================


// Función principal del Ojeador (con lógica de rotación y captura de imagen)
async function runScraper() {
    console.log("Iniciando ojeador con lógica de rotación inteligente...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = [];
    let queryCount = 0;

    try {
        await client.connect();
        const database = client.db(dbName);
        const artistsCollection = database.collection(artistsCollectionName);
        const tempCollection = database.collection(tempCollectionName);
        console.log("✅ Conectado a la base de datos.");

        const ARTIST_DAILY_LIMIT = 30;
        console.log(`Obteniendo los próximos ${ARTIST_DAILY_LIMIT} artistas de la cola (priorizando nuevos y no revisados)...`);

        const artistsToSearch = await artistsCollection
            .find({})
            .sort({ lastScrapedAt: 1 })
            .limit(ARTIST_DAILY_LIMIT)
            .toArray();

        console.log(`Encontrados ${artistsToSearch.length} artistas para procesar hoy.`);

        for (const artist of artistsToSearch) {
            console.log(`-------------------------------------------`);
            console.log(`Procesando artista: ${artist.name}`);
            try {
                const searchQuery = `concierto flamenco "${artist.name}" 2025`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                console.log(` -> 🔍 Realizando búsqueda en Google: "${searchQuery}"`);

                queryCount++;
                const response = await axios.get(searchUrl);
                const searchResults = response.data.items || [];
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                const limitedResults = searchResults.slice(0, 1);
                console.log(` -> Procesando solo el primer resultado para optimizar.`);
                for (const result of limitedResults) {
                    const title = result.title.toLowerCase();
                    const snippet = result.snippet.toLowerCase();
                    const artistNameLower = artist.name.toLowerCase();

                    if (title.includes(artistNameLower) || snippet.includes(artistNameLower)) {
                        const eventsFromAI = await extractEventDataFromURL(result.link);
                        if (eventsFromAI && eventsFromAI.length > 0) {
                            eventsFromAI.forEach(event => {
                                if (isFutureEvent(event.date)) {
                                    const imageUrl = result.pagemap?.cse_image?.[0]?.src || null;
                                    event.imageUrl = imageUrl;
                                    if (imageUrl) {
                                        console.log(`   -> 🖼️ Imagen encontrada: ${imageUrl}`);
                                    }
                                    allNewEvents.push(event);
                                }
                            });
                        }
                    }
                }
            } catch (error) {
                console.error(` -> ❌ Error procesando a ${artist.name}:`, error.message);
            }

            await artistsCollection.updateOne(
                { _id: artist._id },
                { $set: { lastScrapedAt: new Date() } }
            );
            console.log(` -> ✅ Artista "${artist.name}" marcado como revisado.`);
            await delay(1500);
        }

        console.log(`-------------------------------------------`);
        console.log(`Proceso de búsqueda finalizado. Total de eventos nuevos encontrados: ${allNewEvents.length}`);

        if (allNewEvents.length > 0) {
            console.log("Guardando eventos encontrados en la colección temporal...");
            await tempCollection.deleteMany({}); // Limpiamos la colección temporal antes de insertar
            await tempCollection.insertMany(allNewEvents);
            console.log(`✅ ${allNewEvents.length} eventos guardados con éxito en la colección '${tempCollectionName}'.`);

            // ==================================================================
            // --- INICIO: LLAMADA A LA NUEVA LÓGICA DE INGESTA DE ARTISTAS ---
            // ==================================================================
            await findAndIngestNewArtists(allNewEvents, database);
            // ==================================================================
            // --- FIN: LLAMADA A LA NUEVA LÓGICA ---
            // ==================================================================

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

// -------------------------------------------------------------
// --- HANDLER PARA VERCEL (VERSIÓN MEJORADA CON TRY/CATCH) ---
// -------------------------------------------------------------
module.exports = async (req, res) => {
    try {
        // Doble verificación de variables por si el script se ejecuta directamente
        const mongoUri = process.env.MONGO_URI;
        const googleApiKey = process.env.GOOGLE_API_KEY;
        const googleCx = process.env.GOOGLE_CX;
        const geminiApiKey = process.env.GEMINI_API_KEY;

        if (!mongoUri || !googleApiKey || !googleCx || !geminiApiKey) {
            throw new Error('Faltan variables de entorno críticas.');
        }

        // Ejecutamos el scraper principal
        await runScraper();

        res.status(200).send('Ojeador ejecutado con éxito.');
    } catch (error) {
        console.error('Error fatal en el handler de Vercel:', error.message);
        res.status(500).send(`Error en el proceso del ojeador: ${error.message}`);
    }
};