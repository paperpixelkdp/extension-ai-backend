const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');
require('dotenv').config(); // Gizli dosya (.env) okuyucu

const app = express();
app.use(cors());
app.use(express.json());

// --- AYARLAR ---
const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY, // Şifreyi koddan değil, gizli kasadan al
    baseURL: "https://api.groq.com/openai/v1", // Groq Adresi
});

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
        const candidateLinks = Array.from(uniqueLinks).slice(0, 20);
        
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
            if (marketData.length >= 15) break; // LİMİT ARTIRILDI: 15 Rakip

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
                // DÜZELTME: Yeni tasarım sınıfları (.Pa2dE) eklendi
                const name = $$('.Pa2dE').text().trim() || $$('h1').text().trim() || "Unknown";
                
                // Önce tam açıklamayı (itemprop) dene, yoksa meta etiketindeki özeti al
                // DÜZELTME: .mN52G sınıfı (Yeni Tasarım) en başa eklendi
                const description = $$('.mN52G').text().trim() || 
                                    $$('[itemprop="description"]:not(meta)').text().trim() || 
                                    $$('.C7k78').text().trim() || 
                                    $$('meta[property="og:description"]').attr('content') || 
                                    $$('.TZFoid').text() || ""; 
                
                console.log(`📄 ${name} -> Okunan Açıklama: ${description.length} karakter`);

                // --- YENİ ÖZELLİK: Puan ve Kullanıcı Sayısı Avcılığı ---
                const fullText = $$('body').text();
                let rating = "N/A";
                let users = "N/A";

                // DÜZELTME: Puan için .Vq0ZA sınıfı
                const ratingEl = $$('.Vq0ZA').first().text().trim();
                if (ratingEl) rating = ratingEl;
                else { const m = fullText.match(/(\d[\.,]\d)\s*(out of 5|\/5)/); if(m) rating = m[1]; }

                // DÜZELTME: Kullanıcı sayısı için .F9iKBc sınıfı
                const usersEl = $$('.F9iKBc').text().trim();
                if (usersEl) { const m = usersEl.match(/([\d,\.]+\+?)\s*(users|kullanıcı)/i); if(m) users = m[1]; }
                else { const m = fullText.match(/([\d,\.]+\+?)\s*(users|kullanıcı)/i); if(m) users = m[1]; }

                // --- YENİ: Son Güncelleme Tarihi (Updated) ---
                let lastUpdated = "Unknown";
                // "Updated" yazan div'i bul ve bir sonraki kardeş elementin (tarihin) metnini al
                const updatedLabel = $$('div').filter((i, el) => $$(el).text().trim() === 'Updated').first();
                if (updatedLabel.length > 0) {
                    lastUpdated = updatedLabel.next().text().trim();
                }
                
                // --- FİLTRELEME: Başlık aranan kelimeyi içeriyor mu? ---
                const nameLower = name.toLowerCase();
                // Aranan kelimelerden EN AZ BİRİ başlıkta geçiyorsa kabul et
                const isRelevant = searchTerms.some(term => nameLower.includes(term));

                if (isRelevant) {
                    marketData.push({
                        name: name,
                        description: description.substring(0, 2000),
                        rating: rating,
                        users: users,
                        lastUpdated: lastUpdated
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

// --- 2. FONKSİYON: AI Analizi Yap ---
async function analyzeWithAI(marketData, userIntent, contextInfo) {
    const systemPrompt = `You are a cynical, strict Venture Capitalist and Software Auditor. You HATE losing money. Your default stance is "NO" unless proven otherwise. You analyze Chrome Extension markets for a SOLO DEVELOPER with limited budget. ${contextInfo || ""} Your goal is to find reasons NOT to build this. Be harsh. Be critical. Do not be polite.`;
    
    // Veriyi AI için metne döküyoruz
    const dataText = marketData.map((app, index) => `
    [COMPETITOR ${index + 1}]: ${app.name}
    STATS: ${app.users} users | ${app.rating} stars | Last Updated: ${app.lastUpdated || "Unknown"}
    DESCRIPTION/FEATURES: ${app.description}
    `).join("\n----------------\n");

    const userPrompt = `
    User Intent: "${userIntent}"
    Here is the raw description data of the TOP COMPETITORS I scraped from the store:

    ${dataText}

    Analyze this data deeply. Focus on the "Last Updated" dates (Current Year is 2026), "Ratings", and "User Counts".
    
    STRICT SCORING RULES (Follow these or you fail):
    1. SATURATION KILLER: If you see ANY competitor with 100,000+ users and a 4.5+ rating, the Score MUST be below 40. Verdict MUST be "AVOID". The market is taken.
    2. DOMINANCE CHECK: If there are 3+ competitors with 10,000+ users and good ratings (>4.2), Score MUST be below 60. Verdict: "CAUTION".
    3. TECHNICAL TRAP: If the idea requires complex tech (Video editing, AI processing, 3D), penalize the score by -20 points. We are a solo dev.
    4. THE OPPORTUNITY: Only give a score above 75 IF competitors are old (not updated since 2024), broken (ratings < 3.5), or non-existent.

    LOGIC FOR ANALYSIS:
    1. FEASIBILITY: Start with a low score. Only increase it if you find a GAP.
    2. MUST-HAVES: List features that are absolutely required to even compete.
    3. WEAKNESSES: Roast the competitors. Are they ugly? Old? Broken? Expensive?
    
    Provide a strategic report in English with exactly these 4 sections.
    
    IMPORTANT: Format your response as raw HTML code (without \`\`\`html tags). 
    Do not use markdown symbols like ** or ##. 
    Use <h3> for section titles (e.g. <h3>1. MARKET FEASIBILITY & VERDICT</h3>).
    Use <ul> and <li> for ALL content to make it scannable like a data table.
    Do not use quotation marks ("") around the text.
    
    CRITICAL INSTRUCTIONS:
    1. FEASIBILITY: Give a score (0-100). If competitors are old/bad, score high. If they are perfect, score low. 
       - **Reasoning MUST cite specific data**: "AVOID because 'Competitor X' has 2M users and 4.8 rating. You cannot beat them."
    2. MUST-HAVE: List the CORE features. Don't skip the basics. Explain WHY it's needed.
    3. WEAKNESSES: Focus on what the MARKET LEADERS are missing or doing poorly.
    4. CREATIVE IDEAS: Suggest unique, innovative features that NO competitor has. 
       - **Format**: [Feature Name]: [Clear explanation of what it does and the benefit].
    
    Structure:
    <h3>1. MARKET FEASIBILITY & VERDICT</h3>
    <ul>
        <li><strong>Score</strong>: [0-100]/100 (Be harsh!)</li>
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
    const { keyword, intent, marketData, context } = req.body;
    const targetIntent = intent || keyword;
    
    if (!targetIntent) {
        return res.status(400).json({ error: 'Intent/Keyword is required' });
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
