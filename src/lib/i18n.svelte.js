// Lightweight i18n. English is the source of truth: the English string IS the key, and
// Turkish is looked up from TR. `lang` is reactive ($state), so t() calls inside component
// templates re-render automatically when the language is switched. Default is English.
const TR = {
  // top bar / nav
  'Notes': 'Notlar', 'Library': 'Kaynakça', 'Search': 'Ara', 'Synthesis': 'Sentez', 'Graph': 'Graf',
  'Focus': 'Odak', 'Theme': 'Tema', 'Settings': 'Ayarlar', '+ New': '+ Yeni', '＋ New': '＋ Yeni',
  // note view
  'No folder': 'Klasörsüz', 'Read': 'Oku', 'Write': 'Yaz', 'saved': 'kaydedildi',
  'Move to folder': 'Klasöre taşı', 'title': 'başlık', 'Export this note': 'Bu notu dışa aktar', 'Export': 'Dışa aktar',
  '+ Folder': '+ Klasör', 'Export note': 'Notu dışa aktar',
  // sidebar / vault
  'Browser storage': 'Tarayıcı belleği', 'use a folder…': 'bir klasör kullan…', 'open folder…': 'klasör aç…',
  'use browser': 'tarayıcıyı kullan', 'browser': 'tarayıcı', 'Synced': 'Eşitlendi',
  'TAGS': 'ETİKETLER', 'VAULT': 'KASA', 'RESONANCE · ON-DEVICE': 'REZONANS · CİHAZDA',
  'REFERENCED IN': 'ATIF ALDIĞI YERLER', 'LOCAL GRAPH': 'YEREL GRAF', 'enable AI model': 'yapay zekâ modelini etkinleştir',
  'No backlinks yet.': 'Henüz geri bağlantı yok.', 'full': 'tam',
  // resonance / graph
  'Resize left sidebar': 'Sol kenar çubuğunu yeniden boyutlandır', 'Resize right sidebar': 'Sağ kenar çubuğunu yeniden boyutlandır',
  'Knowledge graph': 'Bilgi grafı', '✕ Close': '✕ Kapat', 'Close': 'Kapat',
  'zoom': 'yakınlaştır', 'pan': 'kaydır', 'move': 'taşı', 'open': 'aç', 'select': 'seç',
  // synthesis modal
  "This week's synthesis": 'Bu haftanın sentezi',
  "Pairs of notes that resemble each other but you've never linked. Write the sentence that connects them.":
    'Birbirine benzeyen ama hiç bağlamadığınız not çiftleri. Onları birleştiren cümleyi yazın.',
  'Everything similar is already linked. Good week.': 'Benzeyen her şey zaten bağlı. İyi bir hafta.',
  // settings
  'Appearance': 'Görünüm', 'Light': 'Açık', 'Dark': 'Koyu', 'View zoom': 'Görünüm yakınlaştırması', 'reset': 'sıfırla',
  'Language': 'Dil', 'English': 'English', 'Türkçe': 'Türkçe',
  'On-device machine': 'Cihazdaki makine', 'Connection suggestions': 'Bağlantı önerileri',
  'MiniLM — runs on your device, ~23 MB once': 'MiniLM — cihazınızda çalışır, tek seferlik ~23 MB',
  'Enable': 'Etkinleştir', 'downloading': 'indiriliyor', 'unavailable — using the light method': 'kullanılamıyor — hafif yöntem kullanılıyor',
  'Your data': 'Verileriniz', 'Storage': 'Depolama',
  'a folder of Markdown files on your disk': 'diskinizdeki Markdown dosyalarından oluşan bir klasör',
  'this browser (still yours — connect a folder any time)': 'bu tarayıcı (yine sizin — istediğiniz zaman bir klasör bağlayın)',
  'Use browser': 'Tarayıcıyı kullan', 'Choose a folder…': 'Bir klasör seçin…', 'Open folder…': 'Klasör aç…', 'Opening…': 'Açılıyor…',
  'Sync across devices': 'Cihazlar arası eşitleme',
  'Put the folder in Dropbox, iCloud Drive, OneDrive, or Syncthing, then open the same folder on your other devices. Arf keeps it in step automatically — desktop and web, both ways.':
    'Klasörü Dropbox, iCloud Drive, OneDrive veya Syncthing içine koyun, sonra diğer cihazlarınızda aynı klasörü açın. Arf her iki yönde de — masaüstü ve web — otomatik olarak eşitler.',
  'Workspace backup': 'Çalışma alanı yedeği',
  'one .arf file with every note, folder, and reference': 'her not, klasör ve kaynağı içeren tek bir .arf dosyası',
  'Export .arf': '.arf dışa aktar', 'Import…': 'İçe aktar…', 'About': 'Hakkında', 'Docs': 'Belgeler', 'Source': 'Kaynak kod',
  // editor toolbar
  'Heading 1': 'Başlık 1', 'Heading 2': 'Başlık 2', 'Heading 3': 'Başlık 3', 'Bold': 'Kalın', 'Italic': 'İtalik',
  'Inline code': 'Satır içi kod', 'Link': 'Bağlantı', 'List': 'Liste', 'Quote': 'Alıntı', 'Bullet list': 'Madde listesi',
  // export modal
  'Export writing': 'Yazıyı dışa aktar',
  'Your note as a clean document — headings kept with their text, images fit to the page.':
    'Notunuz temiz bir belge olarak — başlıklar metinleriyle birlikte, görseller sayfaya sığdırılmış.',
  'Markdown': 'Markdown', 'HTML': 'HTML', 'PDF': 'PDF', 'Page size': 'Sayfa boyutu', 'Margins': 'Kenar boşlukları',
  'Narrow': 'Dar', 'Normal': 'Normal', 'Wide': 'Geniş', 'Include title heading': 'Başlığı belge başı olarak ekle',
  'Number section headings': 'Bölüm başlıklarını numaralandır', 'Keep headings with their text (no orphans)': 'Başlıkları metinleriyle tut (öksüz kalmasın)',
  'Fit images & code to the page (no out-scaling)': 'Görselleri ve kodu sayfaya sığdır (taşma olmasın)',
  'Export as PDF': 'PDF olarak dışa aktar', 'Export as HTML': 'HTML olarak dışa aktar', 'Export as Markdown': 'Markdown olarak dışa aktar',
  'Copy': 'Kopyala', 'Copied': 'Kopyalandı', 'Cancel': 'İptal',
  // library
  'All': 'Tümü', 'Articles': 'Makaleler', 'Books': 'Kitaplar', 'Magazines': 'Dergiler', 'Webpages': 'Web sayfaları', 'Preprints': 'Ön baskılar',
  '＋ Add reference': '＋ Kaynak ekle', '⇩ Export library': '⇩ Kaynakçayı dışa aktar', 'Add reference': 'Kaynak ekle',
  'Fetch from open libraries': 'Açık kütüphanelerden getir', 'Looking up…': 'Aranıyor…',
  'Queries Crossref (DOI · arXiv) and Open Library (ISBN).': 'Crossref (DOI · arXiv) ve Open Library (ISBN) sorgular.',
  'No match found.': 'Eşleşme bulunamadı.', 'Lookup timed out — check your connection and try again.': 'Arama zaman aşımına uğradı — bağlantınızı kontrol edip yeniden deneyin.',
  'Lookup failed — try again, or add it by hand.': 'Arama başarısız — yeniden deneyin veya elle ekleyin.',
  'You can still add it and fill the fields by hand.': 'Yine de ekleyip alanları elle doldurabilirsiniz.',
  'Add to Library': 'Kaynakçaya ekle', 'REFERENCE DETAIL': 'KAYNAK AYRINTISI', 'Export this reference': 'Bu kaynağı dışa aktar',
  'TITLE': 'BAŞLIK', 'AUTHORS': 'YAZARLAR', 'TYPE · YEAR': 'TÜR · YIL', 'PUBLISHER': 'YAYINCI', 'ISBN': 'ISBN',
  'FETCHED FROM': 'ŞU KAYNAKTAN GETİRİLDİ', 'ABSTRACT': 'ÖZET', 'CONTAINER': 'KAYNAK', 'VOLUME': 'CİLT', 'PAGES': 'SAYFALAR',
  // mobile tabs
  'Weekly synthesis': 'Haftalık sentez', 'Light / dark': 'Açık / koyu',
  // banners
  '⚠ Couldn’t save — your browser storage may be full or blocked. Export this note now to avoid losing it.':
    '⚠ Kaydedilemedi — tarayıcı belleğiniz dolu veya engellenmiş olabilir. Kaybetmemek için bu notu şimdi dışa aktarın.',
  'Dismiss': 'Kapat',
  // more app strings
  'New': 'Yeni', 'Vault': 'Kasa', 'New folder': 'Yeni klasör', 'Subfolder of': 'Alt klasör:', 'Folder name': 'Klasör adı',
  'clear': 'temizle', 'Untitled': 'Adsız', 'Tags': 'Etiketler', 'Referenced in': 'Atıf alan',
  'Resonance': 'Rezonans', 'on-device': 'cihazda', 'model': 'model', 'on device': 'cihazda',
  'Nothing close enough yet.': 'Henüz yeterince yakın bir şey yok.', 'Local graph': 'Yerel graf',
  'scroll': 'kaydırma', 'drag bg': 'arka planı sürükle', 'drag node': 'düğümü sürükle', 'click': 'tıkla',
  'Search notes, tags, or ideas…': 'Notlarda, etiketlerde veya fikirlerde ara…', 'No matches': 'Eşleşme yok',
  'Related · on-device': 'İlgili · cihazda', 'Title': 'Başlık', 'Tag': 'Etiket', 'Text': 'Metin',
  'might connect to': 'şununla bağlanabilir:', 'Auto-syncing to': 'Şununla eşitleniyor:',
  'Markdown files on your disk': 'diskinizdeki Markdown dosyaları',
  'This browser (still yours — connect a folder any time)': 'Bu tarayıcı (yine sizin — istediğiniz zaman bir klasör bağlayın)',
  'on': 'açık', 'See this note in the graph': 'Bu notu grafta gör', 'enable AI': 'YZ’yi aç',
  'No matches.': 'Eşleşme yok.', 'Search your vault by title, tag, or text.': 'Kasanızda başlığa, etikete veya metne göre arayın.',
  'Search notes, tags, ideas…': 'Notlarda, etiketlerde, fikirlerde ara…', 'browser': 'tarayıcı',
  '⚠ Couldn’t save — storage may be full. Export this note now.': '⚠ Kaydedilemedi — depolama dolu olabilir. Bu notu şimdi dışa aktarın.',
  '⚠ Saved notes couldn’t be read; a backup was kept.': '⚠ Kayıtlı notlar okunamadı; bir yedek saklandı.',
  // library
  'add & fill by hand': 'ekle ve elle doldur', 'Web': 'Web', 'Dataset': 'Veri kümesi', 'Article': 'Makale', 'Book': 'Kitap', 'Preprint': 'Ön baskı',
  'Magazine': 'Dergi', 'references': 'kaynak', 'reference': 'kaynak',
  'Paste a DOI, ISBN, arXiv ID, or URL — Arf fetches from open libraries.': 'Bir DOI, ISBN, arXiv kimliği veya URL yapıştırın — Arf açık kütüphanelerden getirir.',
  'Reference detail': 'Kaynak ayrıntısı', 'Authors': 'Yazarlar', 'Type · Year': 'Tür · Yıl', 'Published in': 'Yayımlandığı yer', 'Site': 'Site', 'Publisher': 'Yayıncı',
  'Archived snapshot · Wayback Machine': 'Arşiv anlık görüntüsü · Wayback Machine', 'captured': 'yakalandı', 'accessed': 'erişildi',
  'Abstract': 'Özet', 'Fetched from': 'Şu kaynaktan getirildi', 'Select a reference.': 'Bir kaynak seçin.',
  'Export references': 'Kaynakları dışa aktar',
  'Every format your tools need — BibTeX, RIS for EndNote, CSL-JSON, formatted styles, Zenodo.': 'Araçlarınızın ihtiyaç duyduğu her biçim — BibTeX, EndNote için RIS, CSL-JSON, biçimlendirilmiş stiller, Zenodo.',
  '⇩ Export library': '⇩ Kaynakçayı dışa aktar', '⇩ Export this reference': '⇩ Bu kaynağı dışa aktar',
};
function load() { try { return localStorage.getItem('arf-lang') === 'tr' ? 'tr' : 'en'; } catch (e) { return 'en'; } }
let lang = $state(load());
export function getLang() { return lang; }
export function setLang(l) { lang = l === 'tr' ? 'tr' : 'en'; try { localStorage.setItem('arf-lang', lang); } catch (e) {} try { document.documentElement.lang = lang; } catch (e) {} }
export function t(en) { return lang === 'tr' && TR[en] ? TR[en] : en; }
