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

        // --- ASEGURAR ÍNDICE ---
        console.log("🔧 Asegurando que el índice 'name' exista en la colección de artistas...");
        await artistsCollection.createIndex(
            { name: 1 },
            { unique: true, collation: { locale: 'es', strength: 2 } }
        );
        // --------------------

        console.log("✅ Conectado a MongoDB y con el índice asegurado.");


        let allFoundArtists = [];
        const processUrl = async (result) => {
            try {
                console.log(`   -> Analizando URL: ${result.link}`);
                const pageResponse = await axios.get(result.link, { timeout: 8000 });
                const cleanedContent = cleanHtmlForGemini(pageResponse.data);

                if (cleanedContent.length < 100) return [];

                const prompt = artistExtractionPrompt(result.link, cleanedContent);
                const geminiResult = await geminiModel.generateContent(prompt);
                const responseText = geminiResult.response.text();

                try {
                    const artistsFromPage = JSON.parse(responseText);
                    if (artistsFromPage.length > 0) {
                        console.log(`   ✨ La IA encontró ${artistsFromPage.length} posibles artistas en ${result.link}`);
                    }
                    return artistsFromPage;
                } catch (e) {
                    console.error(`   ⚠️ Error al parsear JSON de la IA para ${result.link}.`);
                    return [];
                }
            } catch (error) {
                console.error(`   ❌ Error procesando ${result.link}: ${error.message}`);
                return [];
            }
        };

        for (const query of discoverySearchQueries) {
            console.log(`---------------------------------\n🔍 Buscando con la consulta: "${query}"`);
            console.time(`[TIMER] Búsqueda y análisis para "${query}"`);

            const searchRes = await customsearch.cse.list({ cx: customSearchEngineId, q: query, auth: googleApiKey, num: 5 });
            const searchResults = searchRes.data.items || [];

            if (searchResults.length > 0) {
                const processingPromises = searchResults.map(processUrl);
                const resultsFromQuery = await Promise.all(processingPromises);
                const artistsFromQuery = resultsFromQuery.flat();
                if(artistsFromQuery.length > 0){
                    allFoundArtists.push(...artistsFromQuery);
                }
            }
            console.timeEnd(`[TIMER] Búsqueda y análisis para "${query}"`);
        }

        console.log(`\n---------------------------------\n🎉 Descubrimiento finalizado. Total de artistas encontrados: ${allFoundArtists.length}`);
        if (allFoundArtists.length === 0) return;

        // --- Ingesta en la Base de Datos (Versión Optimizada) ---
        let newArtistsCount = 0;
        const uniqueArtists = [...new Map(allFoundArtists.map(item => [item.name.toLowerCase(), item])).values()];
        
        // 1. Obtenemos solo los nombres de los artistas encontrados
        // --- FIX: Expresión regular corregida ---
        const foundArtistNames = uniqueArtists.map(artist => new RegExp(`^${artist.name.trim()}`, 'i'));
        // ---------------------------------------

        // 2. Hacemos UNA SOLA consulta a la BD para encontrar cuáles de esos nombres YA EXISTEN
        const existingArtistsCursor = artistsCollection.find({ name: { $in: foundArtistNames } });
        const existingArtists = await existingArtistsCursor.toArray();
        const existingArtistNamesSet = new Set(existingArtists.map(artist => artist.name.toLowerCase()));

        // 3. Comparamos en memoria (mucho más rápido)
        const artistsToInsert = [];
        for (const artist of uniqueArtists) {
            if (!artist.name || typeof artist.name !== 'string') continue;

            if (!existingArtistNamesSet.has(artist.name.trim().toLowerCase())) {
                artistsToInsert.push({
                    name: artist.name.trim(),
                    mainRole: artist.mainRole || 'Desconocido',
                    genres: ['Flamenco'],
                    status: 'pending_review',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    lastScrapedAt: null
                });
                // Para no añadir duplicados de la misma ejecución
                existingArtistNamesSet.add(artist.name.trim().toLowerCase()); 
            }
        }

        // 4. Hacemos UNA SOLA operación de inserción múltiple si hay artistas que añadir
        if (artistsToInsert.length > 0) {
            await artistsCollection.insertMany(artistsToInsert);
            newArtistsCount = artistsToInsert.length;
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

// Para ejecutar en localmente (descomentar si es necesario)
// findNewArtists();