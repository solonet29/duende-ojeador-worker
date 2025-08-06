require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio'); 
const fs = require('fs');
const path = require('path');

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;

// NUEVO: Definimos el límite de consultas que no queremos superar
const QUERY_LIMIT = 90;

if (!mongoUri || !googleApiKey || !googleCx) {
    throw new Error('Faltan variables de entorno críticas: MONGO_URI, GOOGLE_API_KEY o GOOGLE_CX.');
}

// --- FUNCIÓN DE UTILIDAD PARA LA PAUSA ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- FUNCIÓN PRINCIPAL DEL OJEADOR ---
async function runScraper() {
    console.log("Iniciando ojeador con un límite de " + QUERY_LIMIT + " consultas.");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; 
    
    // NUEVO: Inicializamos nuestro contador de consultas
    let queryCount = 0;

    try {
        // 1. CONECTAR A LA BASE DE DATOS
        await client.connect();
        const database = client.db('DuendeDB');
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        // 2. OBTENER LA LISTA DE ARTISTAS DE LA BASE DE DATOS
        const artistsToSearch = await artistsCollection.find({}).toArray();
        console.log(`Encontrados ${artistsToSearch.length} artistas en la base de datos para buscar.`);

        // 3. RECORRER CADA ARTISTA Y BUSCAR EVENTOS
        for (const artist of artistsToSearch) {
            
            // NUEVO: Comprobamos si hemos alcanzado el límite ANTES de hacer la búsqueda
            if (queryCount >= QUERY_LIMIT) {
                console.log(`-------------------------------------------`);
                console.log(`⚠️ Límite de ${QUERY_LIMIT} consultas alcanzado. Deteniendo la búsqueda de nuevos artistas.`);
                break; // Esta palabra clave rompe el bucle y salta al paso 5
            }

            console.log(`-------------------------------------------`);
            console.log(`(Consulta #${queryCount + 1}) Buscando eventos para: ${artist.name}`);
            
            try {
                // Lógica para buscar en Google usando Axios
                const searchQuery = `eventos ${artist.name} entradas`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                
                // NUEVO: Incrementamos el contador justo después de realizar la llamada
                queryCount++; 
                const response = await axios.get(searchUrl);
                
                const searchResults = response.data.items || [];
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                
                const parsedEvents = []; 
                // ... (Aquí iría tu lógica para procesar 'searchResults' y llenar 'parsedEvents') ...

                if (parsedEvents.length > 0) {
                    console.log(` -> ¡Éxito! Se han parseado ${parsedEvents.length} eventos nuevos para este artista.`);
                    allNewEvents.push(...parsedEvents);
                }

            } catch (error) {
                 if (error.response && error.response.status === 429) {
                    console.error(`   -> ❌ ERROR 429: Cuota de Google excedida para el artista ${artist.name}. Deteniendo el script.`);
                    break; // Si recibimos un 429, también paramos inmediatamente.
                 } else {
                    console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
                 }
            }

            console.log("   ...haciendo una pausa para no saturar la API...");
            await delay(1500);
        }

        // 5. GUARDAR LOS RESULTADOS EN EL ARCHIVO JSON
        console.log(`-------------------------------------------`);
        console.log(`Proceso de búsqueda finalizado. Total de eventos nuevos encontrados: ${allNewEvents.length}`);
        
        if (allNewEvents.length > 0) {
            const outputFilePath = path.join(__dirname, 'nuevos_eventos.json');
            const outputData = {
                artistas: [], 
                salas: [],
                eventos: allNewEvents
            };
            fs.writeFileSync(outputFilePath, JSON.stringify(outputData, null, 2));
            console.log(`✅ Resultados guardados con éxito en ${outputFilePath}`);
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