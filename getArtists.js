require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Groq = require("groq-sdk");
const cheerio = require('cheerio'); // Usamos cheerio para limpiar HTML

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;
const groqApiKey = process.env.GROQ_API_KEY;

if (!mongoUri || !googleApiKey || !googleCx || !groqApiKey) {
    throw new Error('Faltan variables de entorno críticas.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const groq = new Groq({ apiKey: groqApiKey });

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
};

const aiPromptTemplate = (url, content) => `
    Eres un bot de extracción de datos experto en flamenco. Tu única misión es encontrar eventos de flamenco en el siguiente texto y devolverlos en un formato JSON.

    - El contenido proviene de la URL: ${url}.
    - Busca conciertos, recitales y festivales que sean futuros (después de hoy). No incluyas eventos pasados.
    - Tu respuesta DEBE ser SOLAMENTE un array JSON, sin texto, explicaciones o comentarios adicionales.

    Reglas del formato JSON:
    - id: un slug único como "antonio-reyes-madrid-2025-10-20".
    - date: en formato "YYYY-MM-DD".
    - Si el evento es en España, rellena la "provincia" basándote en la "city" y el "country".
    - sourceUrl: la URL original.

    Ejemplo del formato JSON requerido:
    [
        {
            "id": "antonio-reyes-madrid-2025-10-20",
            "name": "Concierto de Antonio Reyes",
            "artist": "Antonio Reyes",
            "description": "Recital de cante jondo.",
            "date": "2025-10-20",
            "time": "21:00",
            "venue": "Teatro Real",
            "city": "Madrid",
            "country": "España",
            "provincia": "Madrid",
            "verified": true,
            "sourceUrl": "${url}"
        }
    ]

    Si no se encuentra ningún evento, devuelve un array vacío [].

    Texto a analizar:
    ${content}
`;

function isFutureEvent(dateString) {
    if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        console.warn(`      -> ⚠️ Formato de fecha inválido '${dateString}'. Se descarta el evento.`);
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

// Nueva función de extracción de JSON más robusta
function extractJsonFromResponse(responseText) {
    try {
        const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
            const jsonString = jsonMatch[0];
            return JSON.parse(jsonString);
        }
    } catch (e) {
        // En caso de error, intenta un enfoque más simple
    }

    try {
        return JSON.parse(responseText.trim());
    } catch (e) {
        // Si todo falla, devuelve un array vacío
        return [];
    }
}

async function extractEventDataFromURL(url, retries = 3) {
    console.log(`     -> 🤖 Llamando a la IA (Groq) para analizar la URL: ${url}`);
    
    try {
        const pageResponse = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 10000 
        });
        
        const cleanedContent = cleanHtmlAndExtractText(pageResponse.data);
        
        const prompt = aiPromptTemplate(url, cleanedContent);
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "llama3-8b-8192",
            temperature: 0,
        });

        const text = chatCompletion.choices[0]?.message?.content || '';

        const events = extractJsonFromResponse(text);
        
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
            return [];
        }
    } catch (error) {
        if (error.message.includes('429 Too Many Requests') && retries > 0) {
            console.warn(`      -> ⏳ ERROR 429: Límite de cuota de Groq excedido. Pausando 60 segundos y reintentando...`);
            await delay(60000); 
            return extractEventDataFromURL(url, retries - 1);
        } else {
            console.error(`      -> ❌ Error al llamar a la API de Groq para la URL ${url}:`, error.message);
            return [];
        }
    }
}


async function runScraper() {
    console.log("Iniciando ojeador con lógica de búsqueda y extractor con IA (Groq)...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; 
    let queryCount = 0;

    try {
        await client.connect();
        const database = client.db('DuendeDB');
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        const artistsToSearch = await artistsCollection.find({}).toArray(); 
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