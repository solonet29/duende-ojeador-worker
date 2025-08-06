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

if (!mongoUri || !googleApiKey || !googleCx) {
    throw new Error('Faltan variables de entorno críticas: MONGO_URI, GOOGLE_API_KEY o GOOGLE_CX.');
}

// --- FUNCIÓN DE UTILIDAD PARA LA PAUSA ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- FUNCIÓN PRINCIPAL DEL OJEADOR ---
async function runScraper() {
    console.log("Iniciando ojeador...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; // Array para acumular todos los eventos encontrados

    try {
        // 1. CONECTAR A LA BASE DE DATOS
        await client.connect();
        const database = client.db('DuendeDB'); // Asegúrate de que el nombre de la DB es correcto
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        // 2. OBTENER LA LISTA DE ARTISTAS DE LA BASE DE DATOS
        const artistsToSearch = await artistsCollection.find({}).toArray();
        console.log(`Encontrados ${artistsToSearch.length} artistas en la base de datos para buscar.`);

        // 3. RECORRER CADA ARTISTA Y BUSCAR EVENTOS
        for (const artist of artistsToSearch) {
            console.log(`-------------------------------------------`);
            console.log(`Buscando eventos para: ${artist.name}`);
            
            try {
                // Lógica para buscar en Google usando Axios
                const searchQuery = `eventos ${artist.name} entradas`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                
                const response = await axios.get(searchUrl);
                const searchResults = response.data.items || [];
                
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                
                // Lógica para procesar los resultados con Cheerio (si es necesaria)
                // En este ejemplo, asumimos que la información básica ya está en los resultados de Google
                // y no necesitamos visitar cada link, pero la estructura está aquí por si la necesitas.
                
                const parsedEvents = []; // Array para guardar eventos de ESTE artista

                for(const result of searchResults) {
                    // Aquí procesarías cada 'result' para extraer la info.
                    // Esto es un ejemplo y deberías adaptarlo a tus necesidades.
                    // Por ahora, lo dejamos vacío para que el script sea funcional.
                }

                if (parsedEvents.length > 0) {
                    console.log(` -> ¡Éxito! Se han parseado ${parsedEvents.length} eventos nuevos para este artista.`);
                    allNewEvents.push(...parsedEvents); // Añadimos los eventos encontrados al array general
                }

            } catch (error) {
                // Capturamos el error de una búsqueda individual para no parar todo el script
                 if (error.response && error.response.status === 429) {
                    console.error(`   -> ❌ ERROR 429: Cuota de Google excedida para el artista ${artist.name}. Re-intentando después de una pausa mayor...`);
                    await delay(60000); // Si hay un error de cuota, esperamos 1 minuto
                 } else {
                    console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
                 }
            }

            // 4. ESPERAR ANTES DE LA SIGUIENTE PETICIÓN (LA SOLUCIÓN AL ERROR 429)
            console.log("   ...haciendo una pausa para no saturar la API...");
            await delay(1500); // Pausa de 1.5 segundos
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
        // 6. CERRAR LA CONEXIÓN CON LA BASE DE DATOS
        await client.close();
        console.log("Conexión con la base de datos cerrada.");
    }
}

// --- EJECUTAR EL SCRIPT ---
runScraper();