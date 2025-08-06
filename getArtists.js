require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio'); 
// fs y path ya no son necesarios para el output, pero los dejamos por si los usas para otra cosa
const fs = require('fs');
const path = require('path');

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;
const QUERY_LIMIT = 90;

if (!mongoUri || !googleApiKey || !googleCx) {
    throw new Error('Faltan variables de entorno críticas.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runScraper() {
    console.log("Iniciando ojeador con un límite de " + QUERY_LIMIT + " consultas.");
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
            if (queryCount >= QUERY_LIMIT) {
                console.log(`⚠️ Límite de ${QUERY_LIMIT} consultas alcanzado. Deteniendo la búsqueda.`);
                break; 
            }
            // ... (el resto de tu bucle de búsqueda sigue igual)
            console.log(`-------------------------------------------`);
            console.log(`(Consulta #${queryCount + 1}) Buscando eventos para: ${artist.name}`);
            try {
                const searchQuery = `eventos ${artist.name} entradas`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                queryCount++; 
                const response = await axios.get(searchUrl);
                const searchResults = response.data.items || [];
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                // ... Aquí iría tu lógica de parsing con Cheerio ...
            } catch (error) {
                console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
            }
            await delay(1500);
        }

        // =================================================================
        // --- CAMBIO IMPORTANTE: DE ARCHIVO JSON A BASE DE DATOS ---
        // =================================================================
        console.log(`-------------------------------------------`);
        console.log(`Proceso de búsqueda finalizado. Total de eventos nuevos encontrados: ${allNewEvents.length}`);
        
        if (allNewEvents.length > 0) {
            console.log("Guardando eventos encontrados en la colección temporal de la base de datos...");
            const tempCollection = database.collection('temp_scraped_events');
            
            // 1. Borramos los datos antiguos de la colección temporal
            await tempCollection.deleteMany({}); 
            
            // 2. Insertamos todos los eventos nuevos encontrados de golpe
            await tempCollection.insertMany(allNewEvents);
            
            console.log(`✅ ${allNewEvents.length} eventos guardados con éxito en la colección 'temp_scraped_events'.`);
        } else {
            console.log("No se encontraron eventos nuevos en esta ejecución.");
        }
        // =================================================================
        // --- FIN DEL CAMBIO ---
        // =================================================================

    } catch (error) {
        console.error("Ha ocurrido un error fatal en el proceso principal:", error);
    } finally {
        await client.close();
        console.log("Conexión con la base de datos cerrada.");
    }
}

runScraper();