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
// const QUERY_LIMIT = 90; // Límite desactivado correctamente

if (!mongoUri || !googleApiKey || !googleCx) {
    throw new Error('Faltan variables de entorno críticas.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runScraper() {
    console.log("Iniciando ojeador con lógica de filtrado...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; 
    let queryCount = 0;

    try {
        await client.connect();
        const database = client.db('DuendeDB');
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        // Para probar, puedes limitar a 5 artistas. Para la ejecución completa, quita el .limit(5)
        const artistsToSearch = await artistsCollection.find({}).limit(5).toArray(); 
        console.log(`Encontrados ${artistsToSearch.length} artistas en la base de datos para buscar.`);

        for (const artist of artistsToSearch) {
            console.log(`-------------------------------------------`);
            console.log(`(Consulta #${queryCount + 1}) Buscando eventos para: ${artist.name}`);
            
            try {
                // =============================================================
                // --- INICIO DE LA NUEVA LÓGICA INTELIGENTE ---
                // =============================================================

                // 1. MEJORAMOS LA BÚSQUEDA
                // Usamos comillas para buscar el nombre exacto y añadimos el año.
                const searchQuery = `concierto flamenco "${artist.name}" 2025`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                
                queryCount++; 
                const response = await axios.get(searchUrl);
                const searchResults = response.data.items || [];
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                
                const parsedEvents = []; // Cesta para los eventos limpios de ESTE artista
                
                // 2. CREAMOS EL FILTRO INTELIGENTE
                const positiveKeywords = ['concierto', 'festival', 'actuación', 'gira', 'entradas', 'tickets', 'fecha'];
                const negativeKeywords = ['noticia', 'entrevista', 'disco', 'álbum', 'vídeo'];
                
                for (const result of searchResults) {
                    const title = result.title.toLowerCase();
                    const snippet = result.snippet.toLowerCase();
                    const artistNameLower = artist.name.toLowerCase();

                    // Combinamos título y snippet para buscar
                    const textToSearch = title + " " + snippet;

                    // A. ¿El resultado menciona a nuestro artista? (La prueba más importante)
                    if (!textToSearch.includes(artistNameLower)) {
                        continue; // Si no lo menciona, saltamos al siguiente resultado.
                    }

                    // B. ¿Contiene palabras positivas y no contiene palabras negativas?
                    const hasPositive = positiveKeywords.some(keyword => textToSearch.includes(keyword));
                    const hasNegative = negativeKeywords.some(keyword => textToSearch.includes(keyword));

                    if (hasPositive && !hasNegative) {
                        // ¡PARECE UN BUEN CANDIDATO!
                        console.log(`   -> Candidato encontrado: "${result.title}"`);

                        // 3. CONSTRUIMOS UN EVENTO BÁSICO
                        // Aquí intentamos extraer la información básica. 
                        // Esto es un primer paso, se puede hacer mucho más complejo y preciso.
                        const newEvent = {
                            id: `evt-${artist.id}-${queryCount}-${parsedEvents.length}`, // ID temporal
                            name: result.title, // Usamos el título del resultado como nombre
                            description: result.snippet, // Y el snippet como descripción
                            date: '2025-01-01', // Fecha por defecto (necesitaríamos lógica más avanzada para extraerla)
                            time: '21:00', // Hora por defecto
                            verified: false, // No está verificado porque es un scraping automático
                            sourceUrl: result.link,
                            artist: artist.name,
                            // Los campos de sala, ciudad, etc. requerirían visitar el link con Cheerio
                        };
                        
                        parsedEvents.push(newEvent);
                    }
                }
                
                // =============================================================
                // --- FIN DE LA NUEVA LÓGICA INTELIGENTE ---
                // =============================================================

                if (parsedEvents.length > 0) {
                    console.log(` -> ¡Éxito! Se han parseado ${parsedEvents.length} eventos nuevos para este artista.`);
                    allNewEvents.push(...parsedEvents);
                }

            } catch (error) {
                 if (error.response && error.response.status === 429) {
                    console.error(`   -> ❌ ERROR 429: Cuota de Google excedida...`);
                    await delay(60000);
                 } else {
                    console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
                 }
            }
            await delay(1500);
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