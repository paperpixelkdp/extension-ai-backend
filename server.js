const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');
require('dotenv').config(); // Gizli dosya (.env) okuyucu

const app = express();
app.use(cors());
app.use(express.json());

// --- BASİT IP TAKİP SİSTEMİ (Hafızada) ---
const usageTracker = {}; // { "192.168.1.1": "2026-10-27" }

// --- LİSANS TAKİP SİSTEMİ (IP Kilitleme) ---
// { "LICENSE-KEY": { ips: Set(["1.1.1.1", "2.2.2.2"]), date: "2026-10-27", valid: true } }
const licenseTracker = {}; 

// --- AYARLAR ---
const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY, // Şifreyi koddan değil, gizli kasadan al
    baseURL: "https://api.groq.com/openai/v1", // Groq Adresi
});

// Gumroad Ürün ID'si (Popup.js ile aynı ve en güvenli yöntem)
const GUMROAD_PRODUCT_ID = "j4fE4mjv53egToZOJ0d-0w==";

// İnsan gibi davranmak için bekleme fonksiyonu
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 1. FONKSİYON: Chrome Mağazasında Arama Yap ve Veri Çek ---
async function scrapeChromeStore(keyword) {
    try {
        console.log(`🔍 Aranıyor: ${keyword}`);
        
        const searchUrl = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}`;
        
        // 1. Arama Sayfasını Çek
        const { data: searchHtml } = await axios.get(searchUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9' 
            }
        });
        
        const $ = cheerio.load(searchHtml);
        
        // İlk 10 sonucu bul (Elemek için fazladan alıyoruz)
        // DÜZELTME: Link bazen 'https://...' diye başladığı için '^=' yerine '*=' (içeren) kullanıyoruz.
        // Aynı eklentiye giden birden fazla link olabilir (resim ve başlık), bunları filtreliyoruz (Set kullanarak).
        const uniqueLinks = new Set();
        $('a[href*="/detail/"]').each((i, el) => {
            let href = $(el).attr('href');
            if (href) {
                // Linki temizle ve tam URL yap
                if (!href.startsWith('http')) href = `https://chromewebstore.google.com${href}`;
                // ID kısmına göre benzersizlik kontrolü (basitçe URL'yi ekliyoruz)
                uniqueLinks.add(href);
            }
        });

        // Aday havuzunu genişletiyoruz
        const candidateLinks = Array.from(uniqueLinks).slice(0, 10);
        
        if (candidateLinks.length === 0) {
            console.log("⚠️ Arama sonucunda eklenti bulunamadı.");
            return [];
        }

        console.log(`✅ ${candidateLinks.length} adet aday bulundu. Filtrelenip analiz edilecek...`);
        
        const marketData = [];
        // Aranan kelimeleri parçala (Örn: "Word Counter" -> ["word", "counter"])
        // 2 harften kısa kelimeleri (ve, ile vb.) filtrele
        const searchTerms = keyword.toLowerCase().split(' ').filter(w => w.length > 2);

        // Her bir rakibi gez
        for (const link of candidateLinks) {
            if (marketData.length >= 5) break; // 5 tane temiz rakip bulduysak yeter

            console.log(`➡️ İnceleniyor: ${link}`);
            
            // İnsan gibi davranmak için rastgele bekleme (3-6 saniye arası) - Güvenlik için artırıldı
            const randomDelay = Math.floor(Math.random() * 3000) + 3000;
            console.log(`⏳ İnsan taklidi yapılıyor, ${randomDelay}ms bekleniyor...`);
            await sleep(randomDelay);

            try {
                const { data: detailHtml } = await axios.get(link, {
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept-Language': 'en-US,en;q=0.9'
                    }
                });

                const $$ = cheerio.load(detailHtml);

                // Verileri Ayrıştır (Sadece Açıklama ve Yorumlar odaklı)
                const name = $$('h1').text().trim() || "Unknown";
                const description = $$('meta[property="og:description"]').attr('content') || $$('.TZFoid').text() || ""; // Farklı classlar deniyoruz
                
                // --- YENİ ÖZELLİK: Puan ve Kullanıcı Sayısı Avcılığı ---
                const fullText = $$('body').text();
                let rating = "N/A";
                let users = "N/A";

                // Puanı bul (Örn: "4.5 out of 5" veya "4,5/5")
                const ratingMatch = fullText.match(/(\d[\.,]\d)\s*(out of 5|\/5)/);
                if (ratingMatch) rating = ratingMatch[1];

                // Kullanıcı sayısını bul (Örn: "10,000+ users" veya "2.000+ kullanıcı")
                const usersMatch = fullText.match(/([\d,\.]+\+?)\s*(users|kullanıcı)/i);
                if (usersMatch) users = usersMatch[1];
                
                // --- FİLTRELEME: Başlık aranan kelimeyi içeriyor mu? ---
                const nameLower = name.toLowerCase();
                // Aranan kelimelerden EN AZ BİRİ başlıkta geçiyorsa kabul et
                const isRelevant = searchTerms.some(term => nameLower.includes(term));

                if (isRelevant) {
                    marketData.push({
                        name: name,
                        description: description.substring(0, 2000),
                        rating: rating,
                        users: users
                    });
                    console.log(`✅ Eklendi: ${name}`);
                } else {
                    console.log(`⚠️ Alakasız (Atlandı): ${name}`);
                }

            } catch (err) {
                console.error(`❌ ${link} okunamadı:`, err.message);
            }
        }

        return marketData;

    } catch (error) {
        console.error("⚠️ Genel Scraping Hatası:", error.message);
        return [];
    }
}

// --- YENİ FONKSİYON: Niyetten Anahtar Kelime Üret ---
async function generateSearchKeywords(intent) {
    const systemPrompt = "You are a Chrome Web Store search expert. Your goal is to convert user intent into effective search keywords to find existing competitors.";
    const userPrompt = `
    User Intent: "${intent}"
    
    Provide 3 distinct, short, and effective search queries that would find Chrome Extensions related to this intent.
    Return ONLY a JSON array of strings. Example: ["keyword 1", "keyword 2", "keyword 3"]
    Do not add any markdown or explanation.
    `;
    
    try {
        const completion = await client.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.1,
        });
        
        const content = completion.choices[0].message.content.trim();
        const jsonStr = content.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("Keyword generation failed:", e);
        return [intent]; // Hata olursa orijinal niyeti kullan
    }
}

// --- YENİ FONKSİYON: Lisans ve IP Kontrolü ---
async function verifyLicenseAndIP(licenseKey, userIP) {
    const today = new Date().toISOString().split('T')[0];
    
    // 1. Hafızada bu anahtar var mı?
    if (!licenseTracker[licenseKey]) {
        licenseTracker[licenseKey] = { ips: new Set(), date: today, valid: null };
    }

    const record = licenseTracker[licenseKey];

    // Tarih değiştiyse IP listesini sıfırla (Yeni gün, yeni şans)
    if (record.date !== today) {
        record.date = today;
        record.ips = new Set();
    }

    // 2. Anahtar daha önce doğrulanmamışsa Gumroad'a sor
    if (record.valid === null) {
        try {
            console.log(`🔑 Gumroad Doğrulaması: ${licenseKey}`);
            
            // DÜZELTME: JSON yerine Form Data kullanıyoruz (Popup ile aynı yöntem)
            // Ayrıca 'increment_uses_count: false' diyerek lisans hakkını yemiyoruz.
            const params = new URLSearchParams();
            params.append('product_id', GUMROAD_PRODUCT_ID); // Permalink yerine ID kullanıyoruz
            params.append('license_key', licenseKey);
            params.append('increment_uses_count', 'false');

            const response = await axios.post('https://api.gumroad.com/v2/licenses/verify', params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            if (response.data.success && !response.data.purchase.refunded) {
                record.valid = true;
            } else {
                record.valid = false;
                return { success: false, error: "Invalid or refunded license key." };
            }
        } catch (error) {
            // Hata detayını konsola yazdıralım (404 gelirse permalink yanlıştır)
            console.error("Gumroad API Hatası:", error.response ? error.response.data : error.message);
            
            if (error.response && error.response.status === 404) {
                return { success: false, error: "License check failed: Product not found (Check Permalink)." };
            }
            
            // Gerçek hatayı döndürelim ki ne olduğunu görelim
            const errorMsg = error.response && error.response.data && error.response.data.message ? error.response.data.message : "License verification failed.";
            return { success: false, error: errorMsg };
        }
    }

    // 3. IP Kontrolü (Maksimum 3 farklı IP)
    record.ips.add(userIP);
    if (record.ips.size > 3) {
        return { success: false, error: "License used on too many devices today (Max 3)." };
    }

    return { success: true };
}

// --- 2. FONKSİYON: AI Analizi Yap ---
async function analyzeWithAI(marketData, userIntent, contextInfo) {
    const systemPrompt = `You are an expert Indie Hacker and Chrome Extension Developer. You analyze markets to find gaps for profitable, lightweight Chrome Extensions. ${contextInfo || ""} Your goal is to provide a brutally honest feasibility report.`;
    
    // Veriyi AI için metne döküyoruz
    const dataText = marketData.map((app, index) => `
    [COMPETITOR ${index + 1}]: ${app.name}
    STATS: ${app.users} users | ${app.rating} stars (out of 5)
    DESCRIPTION/FEATURES: ${app.description}
    `).join("\n----------------\n");

    const userPrompt = `
    User Intent: "${userIntent}"
    Here is the raw description data of the TOP 5 COMPETITORS I scraped from the store:

    ${dataText}

    Analyze this data deeply. Focus on the "Last Updated" dates (Current Year is 2026), "Ratings", and "User Counts".
    If competitors are old (2024 or older) or have low ratings (< 4.0), this is a HUGE opportunity.
    
    LOGIC FOR ANALYSIS:
    1. MUST-HAVES: Identify features present in almost ALL competitors. Even if it's very basic (e.g. "Counting tabs" for a Tab Manager), LIST IT. Do not arbitrarily limit the number of items; list ALL core features found.
    2. WEAKNESSES: Look for patterns. If the Market Leader (Highest Users) has a low rating or is old, their entire UX is a weakness. If one app has a feature but others don't, that's a "Gap" in the general market.
    Provide a strategic report in English with exactly these 4 sections.
    
    IMPORTANT: Format your response as raw HTML code (without \`\`\`html tags). 
    Do not use markdown symbols like ** or ##. 
    Use <h3> for section titles (e.g. <h3>1. MARKET FEASIBILITY & VERDICT</h3>).
    Use <ul> and <li> for ALL content to make it scannable like a data table.
    Do not use quotation marks ("") around the text.
    
    CRITICAL INSTRUCTIONS:
    1. FEASIBILITY: Give a score (0-100). If competitors are old/bad, score high. If they are perfect, score low. 
       - **Reasoning MUST cite specific data**: "Enter because average rating is 3.2 and top competitor hasn't updated since 2023."
    2. MUST-HAVE: List the CORE features. Don't skip the basics. Explain WHY it's needed.
    3. WEAKNESSES: Focus on what the MARKET LEADERS are missing or doing poorly.
    4. CREATIVE IDEAS: Suggest unique, innovative features that NO competitor has. 
       - **Format**: [Feature Name]: [Clear explanation of what it does and the benefit].
    
    Structure:
    <h3>1. MARKET FEASIBILITY & VERDICT</h3>
    <ul>
        <li><strong>Score</strong>: [0-100]/100</li>
        <li><strong>Verdict</strong>: [ENTER / AVOID / CAUTION]</li>
        <li><strong>Reasoning</strong>: [Convince the user with DATA. Mention specific User Counts, Ratings, and Dates found in the analysis.]</li>
    </ul>

    <h3>2. MUST-HAVE FEATURES (Baseline)</h3>
    <ul><li><strong>[Core Feature]</strong>: [Explanation (e.g. "Essential for basic functionality")]</li></ul>

    <h3>3. COMPETITOR WEAKNESSES & GAPS</h3>
    <ul><li><strong>[Weakness/Gap]</strong>: [Explain (e.g. "Competitor X lacks this, causing user frustration")]</li></ul>

    <h3>4. CREATIVE EXTENSION IDEAS</h3>
    <ul><li><strong>[Innovative Feature]</strong>: [Description of functionality + User Benefit (e.g. "Auto-Sync: Saves data to cloud automatically so users never lose work.")]</li></ul>
    `;

    const completion = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile", // Groq üzerindeki en güncel ve güçlü model
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        temperature: 0.3,
    });

    return completion.choices[0].message.content;
}

// --- YENİ ENDPOINT: Keyword Üretme ---
app.post('/get-keywords', async (req, res) => {
    const { intent } = req.body;
    if (!intent) return res.status(400).json({ error: 'Intent is required' });
    
    try {
        const keywords = await generateSearchKeywords(intent);
        res.json({ keywords });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- API ENDPOINT ---
app.post('/analyze', async (req, res) => {
    // Frontend'den gelen zengin veriyi alıyoruz
    const { keyword, intent, marketData, context, licenseKey } = req.body;
    const targetIntent = intent || keyword;
    
    if (!targetIntent) {
        return res.status(400).json({ error: 'Intent/Keyword is required' });
    }

    // Kullanıcının IP adresini al
    const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // --- GÜVENLİK VE LİMİT KONTROLÜ ---
    
    if (licenseKey) {
        // --- PRO KULLANICI KONTROLÜ ---
        const verification = await verifyLicenseAndIP(licenseKey, userIP);
        
        if (!verification.success) {
            // Anahtar geçersizse veya IP limiti dolduysa hata ver
            return res.status(403).json({ error: verification.error });
        }
        // Başarılıysa devam et (Limit yok)

    } else {
        // --- FREE KULLANICI KONTROLÜ ---
        // Bugünün tarihi (Sunucu saatiyle - UTC)
        const today = new Date().toISOString().split('T')[0]; // "2026-10-27"

        // Bu IP bugün işlem yapmış mı?
        if (usageTracker[userIP] === today) {
            return res.status(429).json({ 
                error: 'DAILY_LIMIT_REACHED', 
                message: 'Free daily limit reached. Please upgrade to PRO.' 
            });
        }

        // İşlem yapmadıysa bugüne kaydet
        usageTracker[userIP] = today;
    }

    try {
        // 1. Veri Kaynağını Belirle
        // Eğer frontend (popup.js) veriyi tarayıp gönderdiyse onu kullan.
        // Göndermediyse (eski sürümse) sunucu kendisi tarasın (Fallback).
        let data = marketData;
        if (!data || data.length === 0) {
            data = await scrapeChromeStore(targetIntent);
        }
        
        // 2. AI Analizi Yap (Niyet ve Bağlam ile)
        const analysis = await analyzeWithAI(data, targetIntent, context);

        // 3. Sonucu Gönder
        res.json({ 
            success: true, 
            data: data,
            analysis: analysis 
        });

    } catch (error) {
        console.error("❌ AI Hatası:", error);
        // Hatayı detaylı olarak frontend'e gönderiyoruz
        res.status(500).json({ error: error.message || 'AI Analysis failed.' });
    }
});

const PORT = process.env.PORT || 3000; // Render'ın verdiği portu kullan, yoksa 3000
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
