// /api/findArtists.js - El OJEADOR de nuevos talentos

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
const geminiApiKey = process.env.GEMINI_API_KEY;
const googleApiKey = process.env.GOOGLE_API_KEY;
const customSearchEngineId = process.env.GOOGLE_CX;

// Verificación de variables de entorno
if (!mongoUri || !geminiApiKey || !googleApiKey || !customSearchEngineId) {
    throw new Error('Faltan variables de entorno críticas.');
}

// --- Inicialización de Servicios ---
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest', generationConfig: { responseMimeType: 'application/json' } });
const customsearch = google.customsearch('v1');

// --- Búsquedas de Descubrimiento ---
const discoverySearchQueries = [
    'artistas cartel festival flamenco Jerez 2025',
    'nuevos talentos del cante jondo',
    'programación bienal de flamenco sevilla',
    'guitarristas flamencos gira 2025',
    'bailaoras de flamenco revelación'
];

// --- Prompt para Gemini (enfocado solo en artistas) ---
const artistExtractionPrompt = (url, content) => `
    Eres un bot experto en identificar artistas de flamenco.
    Analiza el texto de la URL "${url}" y devuelve un array JSON de objetos, cada uno con un artista que encuentres.
    REGLAS ESTRICTAS:
    1. Tu respuesta DEBE ser exclusivamente un array JSON válido.
    2. El formato de cada objeto es: { "name": "Nombre del Artista", "mainRole": "Rol Principal" }.
    3. El rol debe ser una de estas categorías: "Cantaor", "Bailaor", "Guitarrista", "Percusionista", "Grupo", "Otro".
    4. Incluye solo artistas, no nombres de eventos, lugares o ciudades.
    5. Si no encuentras artistas, devuelve un array vacío: [].
    Contenido a analizar:
    ${content}
`;

function cleanHtmlForGemini(html) {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, aside').remove();
    return $('body').text().replace(/\s\s+/g, ' ').trim().substring(0, 15000);
}

// --- Flujo Principal del Ojeador ---
async function findNewArtists() {
    console.log("🚀 Iniciando Ojeador para descubrir nuevos artistas...");
    const client = new MongoClient(mongoUri);

    try {
        await client.connect();
        const db = client.db(dbName);
        const artistsCollection = db.collection(artistsCollectionName);
        console.log("✅ Conectado a MongoDB.");

        let allFoundArtists = [];

        for (const query of discoverySearchQueries) {
            console.log(`---------------------------------\n🔍 Buscando con la consulta: "${query}"`);
            const searchRes = await customsearch.cse.list({ cx: customSearchEngineId, q: query, auth: googleApiKey, num: 5 });
            const searchResults = searchRes.data.items || [];

            for (const result of searchResults) {
                try {
                    console.log(`   -> Analizando URL: ${result.link}`);
                    const pageResponse = await axios.get(result.link, { timeout: 8000 });
                    const cleanedContent = cleanHtmlForGemini(pageResponse.data);

                    if (cleanedContent.length < 100) continue;

                    const prompt = artistExtractionPrompt(result.link, cleanedContent);
                    const geminiResult = await geminiModel.generateContent(prompt);
                    const responseText = geminiResult.response.text();
                    const artistsFromPage = JSON.parse(responseText);

                    if (artistsFromPage.length > 0) {
                        console.log(`   ✨ La IA encontró ${artistsFromPage.length} posibles artistas.`);
                        allFoundArtists.push(...artistsFromPage);
                    }
                } catch (error) {
                    console.error(`   ❌ Error procesando ${result.link}: ${error.message}`);
                }
            }
        }

        console.log(`\n---------------------------------\n🎉 Descubrimiento finalizado. Total de artistas encontrados: ${allFoundArtists.length}`);
        if (allFoundArtists.length === 0) return;

        // --- Ingesta en la Base de Datos ---
        let newArtistsCount = 0;
        const uniqueArtists = [...new Map(allFoundArtists.map(item => [item.name.toLowerCase(), item])).values()];

        for (const artist of uniqueArtists) {
            if (!artist.name || typeof artist.name !== 'string') continue;

            const existingArtist = await artistsCollection.findOne({ name: { $regex: new RegExp(`^${artist.name.trim()}$`, 'i') } });
            if (!existingArtist) {
                const newArtistDoc = {
                    name: artist.name.trim(),
                    mainRole: artist.mainRole || 'Desconocido',
                    genres: ['Flamenco'],
                    status: 'pending_review',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    lastScrapedAt: null // Nulo para que el Vigilante lo coja pronto
                };
                await artistsCollection.insertOne(newArtistDoc);
                newArtistsCount++;
            }
        }
        console.log(`✅ ${newArtistsCount} nuevos artistas han sido añadidos a la base de datos para su revisión.`);

    } catch (error) {
        console.error("💥 Error fatal en el Ojeador:", error);
    } finally {
        await client.close();
        console.log("🔚 Conexión con MongoDB cerrada.");
    }
}

// Para ejecutarlo como un script de Vercel
module.exports = async (req, res) => {
    try {
        await findNewArtists();
        res.status(200).send('Ojeador de artistas ejecutado con éxito.');
    } catch (error) {
        res.status(500).send(`Error en el ojeador de artistas: ${error.message}`);
    }
};

// Para ejecutar localmente (descomentar si es necesario)
// findNewArtists();