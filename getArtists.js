require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const cheerio = require('cheerio');

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!mongoUri || !googleApiKey || !googleCx || !openaiApiKey) {
    throw new Error('Faltan variables de entorno críticas.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const openai = new OpenAI({ apiKey: openaiApiKey });

const cityToProvinceMap = {
    'málaga': 'Málaga',
    'madrid': 'Madrid',
    'barcelona': 'Barcelona',
    'sevilla': 'Sevilla',
    'córdoba': 'Córdoba',
    'granada': 'Granada',
    'jerez de la frontera': 'Cádiz',
    'cádiz': 'Cádiz',
    'valencia': 'Valencia',
    'sotogrande': 'Cádiz',
};

const extractionPromptTemplate = (url, content) => `
    Eres un bot de extracción de datos experto en flamenco. Tu misión es encontrar la información de eventos de flamenco en el siguiente texto y devolverla como texto simple y conciso.

    - El contenido proviene de la URL: ${url}.
    - Busca conciertos, recitales y festivales que sean futuros (después de hoy). No incluyas eventos pasados.
    - Devuelve solo los datos relevantes: nombre del evento, artistas, fecha, hora, lugar, ciudad, país y una breve descripción.

    Texto a analizar:
    ${content}
`;

const formatPromptTemplate = (url, textToFormat) => `
    You are a data formatting bot. Your task is to convert the following text into a valid JSON array of flamenco events.

    - The text comes from the URL: ${url}.
    - Your response MUST be ONLY a JSON array. Do NOT add any extra text or comments.

    JSON Format Rules:
    - id: a unique slug like "antonio-reyes-madrid-2025-10-20".
    - date: in format "YYYY-MM-DD".
    - If the event is in Spain, try to fill the "provincia" field based on the "city" and "country".
    - sourceUrl: the original URL.

    Example of the required JSON format:
    ${JSON.stringify([
        {
            "id": "farruquito-trocadero-flamenco-festival-sotogrande-2025-08-15",
            "name": "Trocadero Flamenco Festival",
            "artist": "Farruquito",
            "description": "Actuación de Farruquito en el Trocadero Flamenco Festival.",
            "date": "2025-08-15",
            "time": "21:00",
            "venue": "Trocadero Flamenco Festival",
            "city": "Sotogrande",
            "provincia": "Cádiz",
            "country": "España",
            "verified": true,
            "sourceUrl": "[https://farruquito.es/events/](https://farruquito.es/events/)"
          }
    ], null, 2)}
    
    Text to format:
    ${textToFormat}
`;

function isFutureEvent(dateString) {
    if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        return false;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = new Date(dateString);
    eventDate.setHours(0, 0, 0, 0);
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
        // Expresión regular para encontrar el bloque de código de Markdown y el JSON
        const markdownJsonMatch = responseText.match(/```(?:json)?\n([\s\S]*?)```/);
        if (markdownJsonMatch && markdownJsonMatch[1]) {
            return JSON.parse(markdownJsonMatch[1]);
        }
    } catch (e) {
    }
    try {
        const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
            const jsonString = jsonMatch[0];
            return JSON.parse(jsonString);
        }
    } catch (e) {
    }
    try {
        return JSON.parse(responseText.trim());
    } catch (e) {
        return [];
    }
}

async function extractEventDataFromURL(url, retries = 3) {
    console.log(`     -> 🤖 Llamando a la IA (OpenAI) para analizar la URL: ${url}`);
    
    try {
        const pageResponse = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 10000 
        });
        
        const cleanedContent = cleanHtmlAndExtractText(pageResponse.data);
        
        const rawResponse = await openai.chat.completions.create({
            messages: [{ role: "user", content: extractionPromptTemplate(url, cleanedContent) }],
            model: "gpt-4o",
            temperature: 0,
        });
        const extractedText = rawResponse.choices[0]?.message?.content || '';

        const formatResponse = await openai.chat.completions.create({
            messages: [{ role: "user", content: formatPromptTemplate(url, extractedText) }],
            model: "gpt-4o",
            temperature: 0,
        });
        const jsonText = formatResponse.choices[0]?.message?.content || '';
        
        const events = extractJsonFromResponse(jsonText);
        
        if (Array.isArray(events) && events.length > 0) {
            return events.map(event => {
                const mappedEvent = { ...event, sourceUrl: url };
                if (mappedEvent.country && mappedEvent.country.toLowerCase() === 'españa' && mappedEvent.city && !mappedEvent.provincia) {
                    const cityLower = mappedEvent.city.toLowerCase();
                    mappedEvent.provincia = cityToProvinceMap[cityLower] || null;
                }
                return mappedEvent;
            });
        } else {
            console.error('      -> ⚠️ La IA no devolvió un bloque JSON válido.');
            console.log('      -> Respuesta cruda de la IA:', jsonText);
            return [];
        }
    } catch (error) {
        if (error.response && error.response.status === 429 && retries > 0) {
            console.warn(`      -> ⏳ ERROR 429: Límite de cuota de OpenAI excedido. Pausando 60 segundos y reintentando...`);
            await delay(60000); 
            return extractEventDataFromURL(url, retries - 1);
        } else {
            console.error(`      -> ❌ Error al llamar a la API de OpenAI para la URL ${url}:`, error.message);
            return [];
        }
    }
}


async function runScraper() {
    console.log("Iniciando ojeador con lógica de búsqueda y extractor con IA (OpenAI)...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; 
    let queryCount = 0;

    try {
        await client.connect();
        const database = client.db('DuendeDB');
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        const artistsToSearch = await artistsCollection.find({}).skip(10).limit(10).toArray(); 
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
                }
            } catch (error) {
                if (error.response && error.response.status === 429) {
                    console.error(`   -> ❌ ERROR 429: Cuota de Google excedida...`);
                } else {
                    console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
                }
            }
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