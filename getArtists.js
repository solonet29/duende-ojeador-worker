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

// --- INICIALIZACIÓN DE GEMINI (CON LA SOLUCIÓN) ---
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash',
    generationConfig: {
        responseMimeType: 'application/json' // <-- ¡LA LÍNEA CLAVE!
    }
});

// --- MAPEO DE CIUDADES A PROVINCIAS ---
const cityToProvinceMap = {
    'málaga': 'Málaga', 'madrid': 'Madrid', 'barcelona': 'Barcelona', 'sevilla': 'Sevilla',
    'córdoba': 'Córdoba', 'granada': 'Granada', 'jerez de la frontera': 'Cádiz',
    'cádiz': 'Cádiz', 'valencia': 'Valencia', 'sotogrande': 'Cádiz',
};

// --- PLANTILLA DE PROMPT PARA LA IA (UNIFICADA Y MEJORADA) ---
const unifiedPromptTemplate = (url, content) => `
    Eres un bot experto en extraer datos de eventos de flamenco.
    Tu única tarea es analizar el texto de la URL "${url}" y devolver un array JSON con los eventos futuros que encuentres.

    REGLAS ESTRICTAS:
    1.  Tu respuesta DEBE ser exclusivamente un array JSON válido. No incluyas texto, comentarios, ni la palabra "json".
    2.  Incluye solo eventos futuros (posteriores a la fecha de hoy).
    3.  El formato de cada objeto debe ser: { "id": "slug-unico", "name": "Nombre", "artist": "Artista Principal", "description": "...", "date": "YYYY-MM-DD", "time": "HH:MM", "venue": "Lugar", "city": "Ciudad", "provincia": "Provincia", "country": "País", "verified": false, "sourceUrl": "${url}" }.
    4.  Si no encuentras ningún evento futuro válido, devuelve un array JSON vacío: [].

    Texto a analizar:
    ${content}
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

function extractJsonFromResponse(responseText) {
    try {
        // Con el MimeType forzado, la respuesta debería ser JSON puro.
        return JSON.parse(responseText);
    } catch (e) {
        console.error(" -> ⚠️ La respuesta de la IA, a pesar de ser forzada a JSON, no es válida:", e.message);
        return [];
    }
}

// --- LÓGICA DE EXTRACCIÓN CON IA ---

async function extractEventDataFromURL(url, retries = 3) {
    console.log(`     -> 🤖 Analizando con IA (modo JSON forzado): ${url}`);
    
    try {
        const pageResponse = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 10000 
        });
        
        const cleanedContent = cleanHtmlAndExtractText(pageResponse.data);
        const prompt = unifiedPromptTemplate(url, cleanedContent);
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        const events = extractJsonFromResponse(responseText);
        
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

// --- FUNCIÓN PRINCIPAL DEL OJEADOR ---

async function runScraper() {
    console.log("Iniciando ojeador con extractor de IA (Gemini)...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; 
    let queryCount = 0;

    try {
        await client.connect();
        const database = client.db('DuendeDB');
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        // !! NOTA: Usa .limit() para probar. Quítalo para una ejecución completa.
        const artistsToSearch = await artistsCollection.find({}).limit(5).toArray(); 
        console.log(`Encontrados ${artistsToSearch.length} artistas en la base de datos para buscar.`);

        for (const artist of artistsToSearch) {
            console.log(`-------------------------------------------`);
            console.log(`(Consulta #${queryCount + 1}) Buscando eventos para: ${artist.name}`);
            
            try {
                const searchQuery = `concierto flamenco "${artist.name}" 2025 entradas`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                
                queryCount++; 
                const response = await axios.get(searchUrl);
                const searchResults = response.data.items || [];
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                
                for (const result of searchResults) {
                    const title = result.title.toLowerCase();
                    const snippet = result.snippet.toLowerCase();
                    const artistNameLower = artist.name.toLowerCase();

                    // Un filtro simple para ver si el resultado es relevante
                    if (title.includes(artistNameLower) || snippet.includes(artistNameLower)) {
                        const eventsFromAI = await extractEventDataFromURL(result.link);
                        if (eventsFromAI && eventsFromAI.length > 0) {
                            eventsFromAI.forEach(event => {
                                if (isFutureEvent(event.date)) {
                                    allNewEvents.push(event);
                                } else {
                                    console.log(`     -> ❌ Descartado: El evento '${event.name}' es del pasado.`);
                                }
                            });
                        }
                    }
                }
            } catch (error) {
                 if (error.response && error.response.status === 429) {
                    console.error(`   -> ❌ ERROR 429: Cuota de Google Search excedida...`);
                 } else {
                    console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
                 }
            }
            await delay(1500); // Pausa para no saturar la API de Google Search
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

// --- EJECUTAR EL SCRIPT ---
runScraper();