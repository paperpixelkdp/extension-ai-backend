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

// --- 2. FONKSİYON: AI Analizi Yap ---
async function analyzeWithAI(marketData) {
    const systemPrompt = "You are an expert Indie Hacker and Chrome Extension Developer. You analyze markets to find gaps for profitable, lightweight micro-SaaS extensions. You present your findings in a structured, high-density list format.";
    
    // Veriyi AI için metne döküyoruz
    const dataText = marketData.map((app, index) => `
    [COMPETITOR ${index + 1}]: ${app.name}
    STATS: ${app.users} users | ${app.rating} stars (out of 5)
    DESCRIPTION/FEATURES: ${app.description}
    `).join("\n----------------\n");

    const userPrompt = `
    I am planning to build a Chrome Extension in this niche.
    Here is the raw description data of the TOP 5 COMPETITORS I scraped from the store:

    ${dataText}

    Analyze this data deeply. Use the STATS (Users & Rating) to find opportunities (e.g. High Users + Low Rating = GAP).
    Provide a strategic report in English with exactly these 5 sections.
    
    IMPORTANT: Format your response as raw HTML code (without \`\`\`html tags). 
    Do not use markdown symbols like ** or ##. 
    Use <h3> for section titles.
    Use <ul> and <li> for ALL content to make it scannable like a data table.
    Do not use quotation marks ("") around the text.
    
    CRITICAL INSTRUCTIONS:
    - First, identify the specific niche based on the competitor data (e.g. SEO, Productivity, Crypto, etc.).
    - Avoid generic terms like "User Interface", "Good Design", or "Compatibility".
    - Be SPECIFIC to that niche.
      - Example: If it's a "Color Picker", suggest "Hex/RGB Converter". If "Note Taker", suggest "Markdown Support".
    - In GAPS, mention specific missing functionalities relevant to this niche.
    - In OPPORTUNITIES, propose concrete Micro-SaaS features that solve specific pain points in this niche.
    
    Structure:
    <h3>1. COMPETITOR DATA MATRIX</h3> 
    <ul><li><strong>[Name]</strong>: [Stats] - [Core Focus/Strategy]</li></ul>

    <h3>2. COMMON FEATURE BASELINE</h3> 
    <ul><li><strong>[Specific Feature/UI]</strong>: [Why it is standard in this niche]</li></ul>

    <h3>3. DETECTED GAPS & WEAKNESSES</h3> 
    <ul><li><strong>[Specific Missing Feature/UX Flaw]</strong>: [Why users hate this]</li></ul>

    <h3>4. STRATEGIC OPPORTUNITIES (Micro-SaaS)</h3> 
    <ul><li><strong>[Concrete Feature Idea]</strong>: [How it solves a pain point]</li></ul>

    <h3>5. RECOMMENDED TECH STACK (Low Cost)</h3> 
    <ul>
        <li><strong>Storage</strong>: [Recommendation (e.g. LocalStorage)]</li>
        <li><strong>Frontend</strong>: [Recommendation]</li>
        <li><strong>Backend</strong>: [Recommendation (or None)]</li>
    </ul>
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

// --- API ENDPOINT ---
app.post('/analyze', async (req, res) => {
    const { keyword } = req.body;
    
    if (!keyword) {
        return res.status(400).json({ error: 'Keyword is required' });
    }

    try {
        // 1. Veriyi Çek
        const data = await scrapeChromeStore(keyword);
        
        // 2. AI Analizi Yap
        const analysis = await analyzeWithAI(data);

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
