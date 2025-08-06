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
    console.log("Iniciando ojeador con lógica de filtrado y scraping Cheerio...");
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
                // --- INICIO DE LA NUEVA LÓGICA INTELIGENTE CON SCRAPING ---
                // =============================================================

                // 1. MEJORAMOS LA BÚSQUEDA
                const searchQuery = `concierto flamenco "${artist.name}" 2025`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                
                queryCount++; 
                const response = await axios.get(searchUrl);
                const searchResults = response.data.items || [];
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                
                const parsedEvents = []; 
                
                // 2. CREAMOS EL FILTRO INTELIGENTE
                const positiveKeywords = ['concierto', 'festival', 'actuación', 'gira', 'entradas', 'tickets', 'fecha'];
                const negativeKeywords = ['noticia', 'entrevista', 'disco', 'álbum', 'vídeo'];
                
                for (const result of searchResults) {
                    const title = result.title.toLowerCase();
                    const snippet = result.snippet.toLowerCase();
                    const artistNameLower = artist.name.toLowerCase();

                    const textToSearch = title + " " + snippet;

                    if (!textToSearch.includes(artistNameLower)) {
                        continue; 
                    }

                    const hasPositive = positiveKeywords.some(keyword => textToSearch.includes(keyword));
                    const hasNegative = negativeKeywords.some(keyword => textToSearch.includes(keyword));

                    if (hasPositive && !hasNegative) {
                        console.log(`   -> Candidato encontrado: "${result.title}"`);
                        console.log(`   -> Scrapeando detalles de: ${result.link}`);

                        let eventData = {
                            id: `evt-${artist._id}-${queryCount}-${parsedEvents.length}`, 
                            name: result.title, 
                            description: result.snippet, 
                            date: null,
                            time: null,
                            venue: null,
                            city: null,
                            verified: false,
                            sourceUrl: result.link,
                            artist: artist.name,
                        };

                        try {
                            const pageResponse = await axios.get(result.link, {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                                },
                                timeout: 10000 // Aumentamos el timeout a 10 segundos
                            });
                            const $ = cheerio.load(pageResponse.data);

                            // --- LÓGICA DE SCRAPING CON CHEERIO ---
                            // Aquí es donde necesitamos tu ayuda para definir los selectores
                            // Ejemplo (debes adaptarlo a los sitios web reales):
                            // Para la fecha:
                            // const dateText = $('span.date-display-single').text();
                            // eventData.date = dateText ? dateText.trim() : null;

                            // Para el lugar:
                            // const venueText = $('.event-venue a').text();
                            // eventData.venue = venueText ? venueText.trim() : null;

                            // NOTA IMPORTANTE: Esta es una parte crítica. Los selectores CSS
                            // cambian de un sitio a otro. Para que funcione bien, necesitarás
                            // inspeccionar manualmente los sitios web que encuentres y definir
                            // los selectores correctos para cada uno.

                            // De momento, dejaremos los campos vacíos, pero aquí iría la lógica
                            // para llenar eventData.date, eventData.venue, etc.

                            // Ejemplo básico y general, que probablemente no funcione para todos los sitios:
                            // $('time, .date, .event-date').each((i, elem) => {
                            //     const text = $(elem).text().trim();
                            //     if (text) {
                            //         eventData.date = text;
                            //         return false; // Salimos del each después de encontrar el primero
                            //     }
                            // });

                            // Si conseguimos rascar algún dato más allá de la búsqueda
                            if (eventData.date || eventData.venue) {
                                parsedEvents.push(eventData);
                            } else {
                                // Si no encontramos datos con Cheerio, al menos guardamos el evento básico
                                // para una revisión manual.
                                parsedEvents.push(eventData);
                            }

                        } catch (scrapeError) {
                            console.error(`     -> ⚠️ Error al scrapear ${result.link}:`, scrapeError.message);
                            // Si el scraping falla, guardamos el evento básico de todas formas.
                            parsedEvents.push(eventData);
                        }
                        
                    }
                }
                
                // =============================================================
                // --- FIN DE LA NUEVA LÓGICA INTELIGENTE CON SCRAPING ---
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
            await delay(1500); // Pausa entre artistas
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