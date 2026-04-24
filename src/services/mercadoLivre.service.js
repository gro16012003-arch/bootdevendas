const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../config/logger');

/**
 * Parser unificado para as páginas do Mercado Livre
 */
const parseProducts = (html, searchTerm, isProxy = false) => {
    const $ = cheerio.load(html);
    const products = [];
    
    const getStableId = (link, title) => {
        const mlbMatch = link.match(/MLB-?(\d+)/i);
        if (mlbMatch) return `MLB${mlbMatch[1]}`;
        const hash = Buffer.from(title || link).toString('base64').substring(0, 8).replace(/[^a-zA-Z0-9]/g, 'x');
        return `MLH-${hash}`;
    };

    const unwrapLink = (link) => {
        if (!link) return link;
        if (isProxy && link.includes('translate.google.com')) {
            try {
                const urlObj = new URL(link);
                const u = urlObj.searchParams.get('u');
                return u ? u : link;
            } catch (e) { return link; }
        }
        return link;
    };

    // Seletores de itens (Expandido para novos layouts)
    const containerSelectors = [
        '.poly-card', 
        '.ui-search-result__content-wrapper', 
        '.ui-search-item',
        '.ui-search-result', 
        '.ui-search-layout__item',
        '.poly-card__content',
        'li.ui-search-layout__item'
    ];
    
    let containerFound = false;
    containerSelectors.forEach(selector => {
        if (products.length >= 30) return;
        const els = $(selector);
        if (els.length > 0) {
            containerFound = true;
            logger.debug(`Found ${els.length} items with selector: ${selector}`);
        }
        
        els.each((i, element) => {
            if (products.length >= 30) return false;
            try {
                // 🛑 VERIFICAÇÃO DE DISPONIBILIDADE
                const elementText = $(element).text().toLowerCase();
                const isUnavailable = elementText.includes('esgotado') || 
                                    elementText.includes('indisponível') ||
                                    $(element).find('.ui-search-item__status-ticket').text().toLowerCase().includes('indisponível');
                if (isUnavailable) return; // ← CORRIGIDO: Estava sendo ignorado!

                // 🔗 CAPTURA DE TÍTULO
                const titleElement = $(element).find('.poly-component__title, .ui-search-item__title, .ui-search-result__content-title, .ui-search-item__group__element.ui-search-item__title, h2, h3').first();
                const title = titleElement.text().trim();
                if (!title) return;

                // 🔗 CAPTURA DE LINK
                const linkElement = $(element).find('a.poly-component__title, a.ui-search-link, a.poly-card__title').first();
                let link = linkElement.attr('href') || $(element).find('a').attr('href') || titleElement.closest('a').attr('href');
                if (!link) return;
                link = unwrapLink(link);
                if (link && link.startsWith('//')) link = 'https:' + link;

                // 🚨 GARANTIA DE AFILIADO: Ignoramos links de anúncios (click1/mclics)
                if (link.includes('click1.mercadolivre') || link.includes('mclics')) {
                    logger.debug(`⏩ Ignorando anúncio patrocinado: ${title}`);
                    return;
                }

                // 🏷️ VERIFICAÇÃO DE PROMOÇÃO (Preferência, não obrigatório)
                const hasDiscount = $(element).find('.andes-money-amount__discount, .ui-search-price__discount').length > 0;

                // ⭐ VERIFICAÇÃO DE QUALIDADE (Avaliação e Vendas)
                const ratingElement = $(element).find('.poly-reviews__rating, .ui-search-reviews__rating-number, .ui-search-item__group__element--reviews').first();
                const ratingText = ratingElement.text();
                const rating = parseFloat(ratingText.replace(',', '.'));
                
                const salesElement = $(element).find('.poly-component__sales, .ui-search-item__group__element--shipping, .ui-search-item__quantity-sold').first();
                const salesText = salesElement.text().toLowerCase();
                
                // Critério: Se tiver avaliação e for menor que 3.5 (baixamos de 4.0), a gente ignora. 
                const isOfficialStore = $(element).text().toLowerCase().includes('loja oficial') || $(element).find('.ui-search-official-store-label').length > 0;
                const hasGoodSales = salesText.includes('vendidos') || salesText.includes('full');

                if (rating && rating < 3.5) {
                    logger.debug(`⏩ Ignorando "${title}" por baixa avaliação: ${rating}`);
                    return;
                }
                
                // 💰 CAPTURA DE PREÇO - CORRIGIDA
                // IMPORTANTE: .poly-price__current é um CONTAINER que tem AMBOS os preços (antigo e atual).
                // Precisamos ir direto no span .andes-money-amount--current para o preço REAL.
                
                // 1) Preço ATUAL (o que o cliente paga)
                const currentMoneyEl = $(element).find('.andes-money-amount--current').filter(function() {
                    // Ignora se estiver dentro de parcelas
                    return $(this).closest('.poly-price__installments, .ui-search-item__group__element--installments').length === 0;
                }).first();
                
                let priceFrac = currentMoneyEl.find('.andes-money-amount__fraction').text().replace(/\D/g, '');
                let priceCents = currentMoneyEl.find('.andes-money-amount__cents').text().replace(/\D/g, '') || '00';
                
                // Fallback: se --current não existir, pega o primeiro que NÃO seja --previous e NÃO seja parcela
                if (!priceFrac) {
                    const fallbackEl = $(element).find('.andes-money-amount').filter(function() {
                        return !$(this).hasClass('andes-money-amount--previous') &&
                               $(this).closest('.poly-price__installments, .ui-search-item__group__element--installments').length === 0;
                    }).first();
                    priceFrac = fallbackEl.find('.andes-money-amount__fraction').text().replace(/\D/g, '');
                    priceCents = fallbackEl.find('.andes-money-amount__cents').text().replace(/\D/g, '') || '00';
                }

                // 2) Preço ANTIGO (riscado)
                const previousMoneyEl = $(element).find('.andes-money-amount--previous').first();
                const oldPriceFrac = previousMoneyEl.find('.andes-money-amount__fraction').text().replace(/\D/g, '');
                const oldPrice = oldPriceFrac ? parseFloat(oldPriceFrac) : null;

                if (!priceFrac) return;

                const price = parseFloat(`${priceFrac}.${priceCents}`);
                
                // Proteção: se o preço atual for MAIOR que o antigo, algo saiu errado
                if (oldPrice && price > oldPrice) {
                     logger.debug(`⚠️ Preço atual (R$ ${price}) > antigo (R$ ${oldPrice}). Invertido. Corrigindo...`);
                     // Inverte: o menor é o atual, o maior é o antigo
                     const realPrice = oldPrice;
                     const realOldPrice = price;
                     // Não vamos usar as variáveis invertidas diretamente, vamos pular este produto
                     return;
                }
                
                // Tentar várias formas de pegar a imagem
                let image = $(element).find('img').attr('data-src') || 
                            $(element).find('img').attr('src') ||
                            $(element).find('img').attr('srcset')?.split(' ')[0] ||
                            $(element).find('.poly-component__picture img').attr('src');

                // Evitar placeholders ou imagens de carregamento
                if (image && (image.includes('data:image') || image.includes('pixel.gif'))) {
                    image = $(element).find('img').attr('data-src') || $(element).find('img').attr('data-srcset')?.split(' ')[0];
                }

                if (title && price && link) {
                    const id = getStableId(link, title);
                    if (!products.find(p => p.id === id)) {
                        products.push({ 
                            id, 
                            title, 
                            price, 
                            oldPrice,
                            hasDiscount,
                            link, 
                            imageUrl: image, 
                            description: `Oferta: ${searchTerm}` 
                        });
                    }
                }
            } catch (err) {
                logger.debug(`Erro no loop de parse: ${err.message}`);
            }
        });
    });

    if (products.length === 0 && !containerFound) {
        if (html.includes('id="captcha"') || html.includes('g-recaptcha') || html.includes('challenge')) {
            logger.warn(`🛑 Bloqueio detectado no conteúdo (Captcha/Challenge found).`);
        } else {
            logger.debug(`Nenhum seletor de container funcionou nesta página.`);
        }
    }

    // ⭐ EMBARALHAMENTO PARA MAIS VARIEDADE
    // Se encontrarmos muitos, pegamos 10 aleatórios dos primeiros 30 para não ser sempre igual
    return products.sort(() => Math.random() - 0.5).slice(0, 10);
};

const getRandomBrIP = () => {
    const bases = ['177', '179', '186', '187', '189', '191', '200', '201'];
    const base = bases[Math.floor(Math.random() * bases.length)];
    return `${base}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
};

/**
 * API Fallback camuflada com Headers de App Mobile e Spoofing de IP
 */
const fetchFromBackupAPI = async (searchTerm) => {
    // Tenta domínios diferentes caso um falhe no DNS (comum no Render)
    // Removido api.mercadolivre.com que estava dando ENOTFOUND
    const apiDomains = ['api.mercadolibre.com'];
    
    for (const domain of apiDomains) {
        try {
            const fakeIP = getRandomBrIP();
            logger.info(`🔌 Tentando API Fallback (${domain}) para: ${searchTerm}...`);
            
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));

            const apiUrl = `https://${domain}/sites/MLB/search?q=${encodeURIComponent(searchTerm)}&limit=50`;
            
            const { data } = await axios.get(apiUrl, {
                headers: {
                    'User-Agent': 'MercadoLibre/10.428.1 (iPhone; iOS 17.5.1; Mobile/21F90)',
                    'X-Forwarded-For': fakeIP,
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
                    'Accept': 'application/json'
                },
                timeout: 8000
            });
            
            if (data.results && data.results.length > 0) {
                const results = data.results.map(p => ({
                    id: p.id,
                    title: p.title,
                    price: p.price,
                    oldPrice: p.original_price,
                    link: p.permalink,
                    imageUrl: p.thumbnail?.replace('-I.jpg', '-O.jpg'),
                    description: 'Oferta Especial'
                }));
                logger.info(`✅ API Fallback (${domain}) funcionou para "${searchTerm}"!`);
                return results;
            }
        } catch (apiErr) {
            logger.warn(`⚠️ Falha no domínio ${domain}: ${apiErr.message}`);
            continue; 
        }
    }
    
    logger.error(`❌ Falha total em todos os domínios de API para "${searchTerm}".`);
    return [];
};

/**
 * Bypass via AllOrigins (Stealth Proxy 4)
 */
const searchViaAllOrigins = async (searchTerm, category = '') => {
    try {
        logger.info(`🕵️ Ativando Scraper Stealth (Proxy 4: AllOrigins) para: ${searchTerm}...`);
        let targetUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}`;
        if (category) {
            targetUrl = `https://lista.mercadolivre.com.br/${category}/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}`;
        }

        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
        
        const { data } = await axios.get(proxyUrl, { timeout: 15000 });
        
        if (data && data.contents) {
            const products = parseProducts(data.contents, searchTerm, true);
            if (products.length > 0) {
                logger.info(`🚀 Proxy 4 (AllOrigins) funcionou! (${products.length} itens)`);
                return products;
            }
        }
        return await fetchFromBackupAPI(searchTerm);
    } catch (err) {
        logger.warn(`⚠️ Erro no Proxy 4: ${err.message}`);
        return await fetchFromBackupAPI(searchTerm);
    }
};

/**
 * Bypass via Redirector Proxy (Stealth Proxy 3)
 */
const searchViaRedirectProxy = async (searchTerm, category = '') => {
    try {
        logger.info(`🕵️ Ativando Scraper Stealth (Proxy 3: Redirector) para: ${searchTerm}...`);
        let targetUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}`;
        if (category) {
            targetUrl = `https://lista.mercadolivre.com.br/${category}/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}`;
        }

        // Tenta usar um bypass de cache e um referer diferente
        const { data: html } = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
                'Accept-Language': 'pt-BR,pt;q=0.9',
                'Referer': 'https://www.google.com.br/'
            },
            timeout: 10000
        });

        const products = parseProducts(html, searchTerm, true);
        if (products.length > 0) {
            logger.info(`🚀 Proxy 3 funcionou! (${products.length} itens)`);
            return products;
        }
        return await searchViaAllOrigins(searchTerm, category);
    } catch (err) {
        return await searchViaAllOrigins(searchTerm, category);
    }
};

/**
 * Bypass via Bing Translator (Stealth Proxy 2)
 */
const searchViaBingProxy = async (searchTerm, category = '') => {
    try {
        logger.info(`🕵️ Ativando Scraper Stealth (Proxy 2: Bing) para: ${searchTerm}...`);
        let targetUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}`;
        if (category) {
            targetUrl = `https://lista.mercadolivre.com.br/${category}/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}`;
        }

        const proxyUrl = `https://www.bing.com/translator/?to=pt&url=${encodeURIComponent(targetUrl)}`;
        
        const { data: html } = await axios.get(proxyUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            },
            timeout: 15000
        });

        const products = parseProducts(html, searchTerm, true);
        
        if (products.length === 0) {
            logger.warn(`ℹ️ Proxy 2 (Bing) falhou. Tentando Proxy 3...`);
            return await searchViaRedirectProxy(searchTerm, category);
        }

        logger.info(`🚀 Proxy 2 (Bing) funcionou! (${products.length} itens)`);
        return products;
    } catch (err) {
        return await searchViaRedirectProxy(searchTerm, category);
    }
};

/**
 * Bypass de IP via Google Translate (Stealth Proxy 1)
 */
const searchViaStealthProxy = async (searchTerm, category = '') => {
    try {
        logger.info(`🕵️ Ativando Scraper Stealth (Proxy 1: Google) para: ${searchTerm}...`);
        let targetUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}`;
        if (category) {
             targetUrl = `https://lista.mercadolivre.com.br/${category}/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}`;
        }
        
        targetUrl += `${targetUrl.includes('?') ? '&' : '?'}b=${Math.random().toString(36).substring(7)}`;

        const proxyUrl = `https://translate.google.com/translate?sl=en&tl=pt&u=${encodeURIComponent(targetUrl)}`;
        
        const { data: html } = await axios.get(proxyUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
            },
            timeout: 15000
        });

        const products = parseProducts(html, searchTerm, true);
        
        if (products.length === 0) {
            logger.warn(`ℹ️ Proxy 1 (Google) falhou. Tentando Proxy 2 (Bing)...`);
            return await searchViaBingProxy(searchTerm, category);
        }

        logger.info(`🚀 Proxy 1 (Google) funcionou! (${products.length} itens)`);
        return products;
    } catch (err) {
        logger.warn(`⚠️ Erro no Proxy 1: ${err.message}. Tentando Proxy 2 (Bing)...`);
        return await searchViaBingProxy(searchTerm, category);
    }
};

/**
 * Busca produtos no Mercado Livre.
 * Tenta Scraper Direto -> Scraper via Proxy (Stealth) -> API Fallback.
 */
const searchProducts = async (searchTerm, category = '') => {
    logger.info(`🔍 Buscando produtos no Mercado Livre para: "${searchTerm}"...`);
    
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1'
    ];

    const referers = [
        'https://www.google.com/',
        'https://www.bing.com/',
        'https://duckduckgo.com/',
        'https://t.co/',
        'https://www.facebook.com/'
    ];

    try {
        // Formato mais simples de busca que muitas vezes ignora alguns filtros de bot
        const url = `https://lista.mercadolivre.com.br/${encodeURIComponent(searchTerm).replace(/%20/g, '-')}_NoIndex_True`;
        
        const selectedUA = userAgents[Math.floor(Math.random() * userAgents.length)];

        logger.info(`🔌 Tentativa Direta (Simples) para: ${searchTerm}...`);
        
        const { data: html, status } = await axios.get(url, {
            headers: {
                'User-Agent': selectedUA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            timeout: 10000,
            validateStatus: () => true
        });

        if (status === 403 || html.includes('id="captcha"') || html.includes('g-recaptcha') || html.includes('Forbidden')) {
            logger.warn(`⚠️ Bloqueio direto detectado (Status ${status}). Ativando Modo Stealth...`);
            return await searchViaStealthProxy(searchTerm, category);
        }

        const products = parseProducts(html, searchTerm);
        
        if (products.length === 0) {
            // Se o scraper direto falhar (pode ser seletor ou bloqueio silencioso)
            logger.info(`ℹ️ 0 produtos no scraper direto para "${searchTerm}". Tentando Modo Stealth...`);
            return await searchViaStealthProxy(searchTerm, category);
        }

        logger.info(`✅ Sucesso no Scraper Direto para "${searchTerm}" (${products.length} itens).`);
        return products;
        
    } catch (error) {
        logger.warn(`⚠️ Erro no Scraper Direto (${error.message}). Tentando Modo Stealth...`);
        return await searchViaStealthProxy(searchTerm, category);
    }
};

module.exports = {
  searchProducts
};
