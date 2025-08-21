// /api/process-url.js - CONSUMIDOR
// Misión: Recibir una URL de la cola de QStash, procesarla y guardar los eventos.

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const cheerio = require('cheerio');
const { verifySignature } = require("@upstash/qstash/nextjs");

// --- Configuración ---
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const eventsCollectionName = 'events';
const geminiApiKey = process.env.GEMINI_API_KEY;

// --- Inicialización de Servicios ---
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', generationConfig: { responseMimeType: 'application/json' } });

// --- PROMPT PARA GEMINI (El mismo que usaba el orquestador) ---
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

// --- Flujo Principal del Consumidor ---
async function processUrl(url, artistName) {
    console.log(`   -> 🤖 Procesando URL: ${url} para el artista ${artistName}`);
    const client = new MongoClient(mongoUri);

    try {
        const pageResponse = await axios.get(url, { timeout: 15000 });
        const cleanedContent = cleanHtmlForGemini(pageResponse.data);

        if (cleanedContent.length < 100) {
            console.log('   -> Contenido demasiado corto, saltando.');
            return;
        }

        const prompt = eventExtractionPrompt(artistName, url, cleanedContent);
        const geminiResult = await geminiModel.generateContent(prompt);
        const responseText = geminiResult.response.text();
        let eventsFromPage = [];

        try {
            const parsedResponse = JSON.parse(responseText);
            if (Array.isArray(parsedResponse)) {
                eventsFromPage = parsedResponse;
            } else if (typeof parsedResponse === 'object' && parsedResponse !== null) {
                eventsFromPage = [parsedResponse];
            }
        } catch (e) {
            console.error(`   ⚠️ Error al parsear JSON de la IA para ${url}. Respuesta no válida:`, responseText);
            return;
        }

        if (eventsFromPage.length > 0) {
            console.log(`   ✨ La IA encontró ${eventsFromPage.length} posibles eventos en ${url}.`);
            await client.connect();
            const db = client.db(dbName);
            const eventsCollection = db.collection(eventsCollectionName);

            const eventsToInsert = [];
            for (const event of eventsFromPage) {
                if (!event.name || !event.date || !event.venue) {
                    console.log(`   ⚠️ Evento omitido por datos incompletos:`, event);
                    continue;
                }

                const existingEvent = await eventsCollection.findOne({
                    artist: artistName,
                    venue: event.venue,
                    date: event.date
                });

                if (!existingEvent) {
                    const newEventDoc = {
                        ...event,
                        artist: artistName,
                        id: `evt-${artistName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${event.date}`,
                        verified: false,
                        contentStatus: 'pending',
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    };
                    eventsToInsert.push(newEventDoc);
                }
            }

            if (eventsToInsert.length > 0) {
                await eventsCollection.insertMany(eventsToInsert);
                console.log(`   ✅ ${eventsToInsert.length} nuevos eventos para ${artistName} añadidos a la base de datos.`);
            }
        }
    } catch (error) {
        console.error(`   ❌ Error procesando ${url}: ${error.message}`);
        // Lanzamos el error para que QStash pueda reintentar la tarea si es necesario
        throw error;
    } finally {
        await client.close();
    }
}

// --- Endpoint para Vercel (Consumidor) ---
async function handler(req, res) {
    try {
        const { url, artistName } = req.body;
        if (!url || !artistName) {
            return res.status(400).send('Falta la URL o el nombre del artista en el cuerpo de la petición.');
        }

        await processUrl(url, artistName);
        res.status(200).send(`URL procesada con éxito: ${url}`);
    } catch (error) {
        res.status(500).send(`Error en el consumidor: ${error.message}`);
    }
}

module.exports = verifySignature(handler);