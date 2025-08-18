// api/processArtist.js - EL TRABAJADOR

require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cheerio = require('cheerio');

// --- Configuración ---
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const tempCollectionName = 'temp_scraped_events';
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;
const geminiApiKey = process.env.GEMINI_API_KEY;

// Verificación de variables de entorno
if (!mongoUri || !googleApiKey || !googleCx || !geminiApiKey) {
    // En un trabajador, es mejor loguear el error que pararlo todo
    console.error('Faltan variables de entorno críticas en el trabajador.');
    // Devolvemos un error para que Vercel sepa que la función falló
    throw new Error('Faltan variables de entorno críticas.');
}

// --- Inicialización de Gemini ---
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash-latest',
    generationConfig: {
        responseMimeType: 'application/json'
    }
});

// --- Plantillas de Prompt ---
const unifiedPromptTemplate = (url, content) => `
    Eres un bot experto en extraer datos de eventos de flamenco.
    Tu única tarea es analizar el texto de la URL "${url}" y devolver un array JSON con los eventos **futuros y de flamenco** que encuentres.
    REGLAS ESTRICTAS:
    1. Tu respuesta DEBE ser exclusivamente un array JSON válido. No incluyas texto, comentarios, ni la palabra "json".
    2. Incluye solo eventos que sean claramente de **flamenco** (conciertos, recitales, espectáculos, etc.).
    3. El formato de cada objeto debe ser: { "id": "slug-unico", "name": "Nombre", "artist": "Nombre del Artista", "description": "...", "date": "YYYY-MM-DD", "time": "HH:MM", "venue": "Lugar", "city": "Ciudad", "provincia": "Provincia", "country": "País", "verified": false, "sourceUrl": "${url}" }.
    4. Asegúrate de que todos los strings dentro del JSON están correctamente escapados.
    5. Si no encuentras ningún evento de flamenco, devuelve un array JSON vacío: [].
    Texto a analizar:
    ${content}
`;

const correctionPromptTemplate = (brokenJson, errorMessage) => `
    El siguiente texto no es un JSON válido. El error es: "${errorMessage}".
    Por favor, arréglalo y devuelve exclusivamente el array JSON corregido y válido. No añadas ningún otro texto.
    Texto a corregir:
    ${brokenJson}
`;

// --- Funciones de Utilidad ---
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

async function extractEventDataFromURL(url, retries = 3) {
    console.log(`     -> 🤖 Analizando con IA (modelo Flash): ${url}`);
    try {
        const pageResponse = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 15000 // Aumentamos timeout a 15s
        });
        const cleanedContent = cleanHtmlAndExtractText(pageResponse.data);

        if (cleanedContent.length < 100) return []; // Ignoramos páginas con poco texto

        const prompt = unifiedPromptTemplate(url, cleanedContent);
        console.log(`       -> 🤖 Llamando a Gemini para extraer datos de eventos...`);

        const result = await model.generateContent(prompt);
        let responseText = result.response.text();
        let events = [];

        try {
            events = JSON.parse(responseText);
        } catch (e) {
            console.warn(`       -> ⚠️ El JSON inicial no es válido (${e.message}). Intentando auto-corrección...`);
            const correctionPrompt = correctionPromptTemplate(responseText, e.message);
            const correctedResult = await model.generateContent(correctionPrompt);
            responseText = correctedResult.response.text();
            try {
                events = JSON.parse(responseText);
                console.log("       -> ✨ Auto-corrección exitosa.");
            } catch (finalError) {
                console.error("       -> ❌ Fallo final al parsear JSON incluso después de corregir:", finalError.message);
            }
        }
        if (events.length > 0) {
            console.log(`       -> ✅ Éxito: La IA ha extraído ${events.length} evento(s).`);
        }
        return events;
    } catch (error) {
        // Manejo de errores de cuota de Gemini
        if ((error.message.includes('429') || (error.response && error.response.status === 429)) && retries > 0) {
            console.warn(`       -> ⏳ ERROR 429: Cuota de Gemini excedida. Pausando 60 segundos...`);
            await delay(60000);
            return extractEventDataFromURL(url, retries - 1);
        } else {
            console.error(`       -> ❌ Error en el proceso de IA para ${url}:`, error.message);
            return [];
        }
    }
}


// --- El Corazón del Trabajador ---
async function processSingleArtist(artist) {
    if (!artist || !artist.name) {
        console.log("No se recibió un artista válido para procesar.");
        return;
    }

    const allNewEvents = [];
    try {
        const searchQuery = `concierto flamenco "${artist.name}" 2025`;
        const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey.trim()}&cx=${googleCx.trim()}&q=${encodeURIComponent(searchQuery)}`;
        console.log(` -> 🔍 Trabajador procesando: "${artist.name}"`);

        const response = await axios.get(searchUrl);
        const searchResults = response.data.items || [];
        console.log(` -> Encontrados ${searchResults.length} resultados en Google para "${artist.name}".`);

        for (const result of searchResults) {
            const eventsFromAI = await extractEventDataFromURL(result.link);

            if (eventsFromAI && eventsFromAI.length > 0) {
                const imageUrl = result.pagemap?.cse_image?.[0]?.src || null;
                if (imageUrl) {
                    console.log(`     -> 🖼️ Imagen encontrada: ${imageUrl}`);
                }

                eventsFromAI.forEach(event => {
                    if (isFutureEvent(event.date)) {
                        event.imageUrl = imageUrl;
                        allNewEvents.push(event);
                    }
                });
            }
        }

        if (allNewEvents.length > 0) {
            const client = new MongoClient(mongoUri);
            await client.connect();
            const database = client.db(dbName);
            const tempCollection = database.collection(tempCollectionName);
            // Usamos un Map para asegurar que no insertamos eventos duplicados de la misma tanda
            const uniqueEvents = [...new Map(allNewEvents.map(e => [e.id || `${e.artist}-${e.date}-${e.venue}`, e])).values()];
            await tempCollection.insertMany(uniqueEvents);
            await client.close();
            console.log(` -> ✅ Trabajador guardó ${uniqueEvents.length} eventos para "${artist.name}".`);
        }
    } catch (error) {
        console.error(` -> ❌ Error del trabajador procesando a ${artist.name}:`, error.message);
    }
}

// --- Handler para Vercel ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const { artist } = req.body;
        if (!artist) {
            return res.status(400).send('Falta el objeto "artist" en el cuerpo de la petición.');
        }

        await processSingleArtist(artist);
        res.status(200).send(`Trabajador terminó la tarea para ${artist.name}`);

    } catch (error) {
        console.error('Error fatal en el trabajador:', error.message);
        res.status(500).send(`Error en el proceso del trabajador: ${error.message}`);
    }
};