require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cheerio = require('cheerio');

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!mongoUri || !googleApiKey || !googleCx || !geminiApiKey) {
    throw new Error('Faltan variables de entorno críticas. Revisa tu archivo .env');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- INICIALIZACIÓN DE GEMINI (Modelo PRO para máxima fiabilidad) ---
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-pro-latest',
    generationConfig: {
        responseMimeType: 'application/json'
    }
});

// --- MAPEO DE CIUDADES A PROVINCIAS ---
const cityToProvinceMap = {
    'málaga': 'Málaga', 'madrid': 'Madrid', 'barcelona': 'Barcelona', 'sevilla': 'Sevilla',
    'córdoba': 'Córdoba', 'granada': 'Granada', 'jerez de la frontera': 'Cádiz',
    'cádiz': 'Cádiz', 'valencia': 'Valencia', 'sotogrande': 'Cádiz',
};

// --- PLANTILLAS DE PROMPT PARA LA IA ---
const unifiedPromptTemplate = (url, content) => `
    Eres un bot experto en extraer datos de eventos de flamenco.
    Tu única tarea es analizar el texto de la URL "${url}" y devolver un array JSON con los eventos futuros que encuentres.
    REGLAS ESTRICTAS:
    1. Tu respuesta DEBE ser exclusivamente un array JSON válido. No incluyas texto, comentarios, ni la palabra "json".
    2. Incluye solo eventos futuros (posteriores a la fecha de hoy).
    3. El formato de cada objeto debe ser: { "id": "slug-unico", "name": "Nombre", "artist": "Artista Principal", "description": "...", "date": "YYYY-MM-DD", "time": "HH:MM", "venue": "Lugar", "city": "Ciudad", "provincia": "Provincia", "country": "País", "verified": false, "sourceUrl": "${url}" }.
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

// --- FUNCIONES DE UTILIDAD ---
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

// --- LÓGICA DE EXTRACCIÓN CON IA (CON AUTO-CORRECCIÓN) ---
async function extractEventDataFromURL(url, retries = 3) {
    console.log(`     -> 🤖 Analizando con IA (modelo Pro): ${url}`);
    try {
        const pageResponse = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 10000 
        });
        const cleanedContent = cleanHtmlAndExtractText(pageResponse.data);
        const prompt = unifiedPromptTemplate(url, cleanedContent);
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

// --- FUNCIÓN PRINCIPAL DEL OJEADOR (VERSIÓN INTELIGENTE Y ROTATIVA) ---
async function runScraper() {
    console.log("Iniciando ojeador con lógica de rotación inteligente...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; 
    let queryCount = 0;

    try {
        await client.connect();
        const database = client.db('DuendeDB');
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        const ARTIST_DAILY_LIMIT = 15;
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
                const searchQuery = `concierto flamenco "${artist.name}" 2025`; // Búsqueda mejorada
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
                                }
                            });
                        }
                    }
                }
            } catch (error) {
                 console.error(`   -> ❌ Error procesando a ${artist.name}:`, error.message);
            }

            // "Sellar" el artista como procesado
            await artistsCollection.updateOne(
                { _id: artist._id },
                { $set: { lastScrapedAt: new Date() } }
            );
            console.log(`   -> ✅ Artista "${artist.name}" marcado como revisado.`);

            await delay(1500);
        }

        console.log(`-------------------------------------------`);
        console.log(`Proceso de búsqueda finalizado. Total de eventos nuevos encontrados: ${allNewEvents.length}`);
        
        if (allNewEvents.length > 0) {
            console.log("Guardando eventos encontrados en la colección temporal...");
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

// --- EJECUTAR EL SCRIPT ---
runScraper();