const UNIVERSITY_ALIASES: Record<string, string[]> = {
  "Aoyama Gakuin University": ["아오야마가쿠인대학교", "아오야마가쿠인대", "아오야마 대학"],
  "Bogazici University": ["보아지치대학교", "보아지치대"],
  "Ca Foscari University in Venice": ["카포스카리대학교", "카포스카리대", "베네치아 카포스카리"],
  "Chemnitz University of Technology": ["켐니츠공과대학교", "켐니츠공대"],
  "Chulalongkorn University": ["출라롱콘대학교", "출라롱콘대"],
  "City University of Hong Kong": ["홍콩시립대학교", "홍콩시립대"],
  "Clarkson University": ["클락슨대학교", "클락슨대"],
  "Daito Bunka University": ["다이토분카대학교", "다이토분카대"],
  "Feng Chia University": ["펑지아대학교", "펑지아대", "봉갑대학교"],
  "Fontys University of Applied Sciences": ["폰티스응용과학대학교", "폰티스대"],
  "Goethe University Frankfurt": ["프랑크푸르트괴테대학교", "괴테대학교", "괴테대"],
  "Hanken School of Economics": ["한켄경제대학교", "한켄경제대", "한켄"],
  "HU University of Applied Sciences Utrecht": ["위트레흐트응용과학대학교", "HU위트레흐트"],
  "ICHEC Brussels Management School": ["이셰크브뤼셀경영대학", "ICHEC브뤼셀"],
  "ICN Business School": ["ICN비즈니스스쿨", "ICN경영대학"],
  "Jean Moulin University Lyon 3": ["장물랭리옹3대학교", "리옹3대학교", "리옹3대"],
  "Kajaani University of Applied Sciences": ["카야니응용과학대학교", "카야니대", "KAMK"],
  "Kiel University": ["킬대학교", "킬대"],
  "KU Leuven": ["루벤가톨릭대학교", "KU루벤", "루벤대"],
  "Kyushu University": ["규슈대학교", "규슈대", "큐슈대학교", "큐슈대"],
  "Linkoping University": ["린셰핑대학교", "린셰핑대", "링셰핑대학교"],
  "LUT University": ["LUT대학교", "라펜란타공과대학교", "LUT대"],
  "MCI Management Center Innsbruck": ["인스브루크MCI", "MCI인스브루크"],
  "National Institute for Oriental Languages and Civilizations (INALCO)": ["프랑스국립동양언어문화원", "이날코", "INALCO"],
  "National Sun Yat-sen University": ["국립중산대학교", "중산대", "쑨원대학교"],
  "National Taiwan University": ["국립대만대학교", "대만대학교", "대만대", "NTU"],
  "Osnabruck University of Applied Sciences": ["오스나브뤼크응용과학대학교", "오스나브뤼크대"],
  "Paris Dauphine University": ["파리도핀대학교", "파리도핀대", "도핀대학교"],
  "Polytechnic University of Milan": ["밀라노공과대학교", "밀라노공대", "폴리테크니코디밀라노"],
  "Pontifical Catholic University of Peru": ["페루가톨릭대학교", "페루가톨릭대", "PUCP"],
  "Rennes School of Business": ["렌비즈니스스쿨", "렌경영대학", "렌느경영대학"],
  "Ruhr University of Bochum": ["보훔루르대학교", "루르대학교", "루르대"],
  "Singapore University of Technology and Design (SUTD)": ["싱가포르기술디자인대학교", "싱가포르기술디자인대", "SUTD"],
  "SKEMA Business School": ["스케마비즈니스스쿨", "스케마경영대학", "SKEMA"],
  "Soka University": ["소카대학교", "소카대", "창가대학교"],
  "Toulouse Business School": ["툴루즈비즈니스스쿨", "툴루즈경영대학", "TBS"],
  "UNICAMP (University of Campinas)": ["캄피나스주립대학교", "캄피나스대학교", "UNICAMP"],
  "Universidad San Francisco de Quito": ["샌프란시스코데키토대학교", "키토샌프란시스코대", "USFQ"],
  "University of Bristol": ["브리스톨대학교", "브리스톨대"],
  "University of Central Lancashire": ["센트럴랭커셔대학교", "중앙랭커셔대학교", "UCLan"],
  "University of Copenhagen": ["코펜하겐대학교", "코펜하겐대"],
  "University of Eastern Finland": ["동핀란드대학교", "동부핀란드대학교", "UEF"],
  "University of Helsinki": ["헬싱키대학교", "헬싱키대"],
  "University of Indonesia": ["인도네시아대학교", "인도네시아대", "UI대학교"],
  "University of Manitoba": ["매니토바대학교", "매니토바대"],
  "University of Rostock": ["로스토크대학교", "로스토크대"],
  "University of Sao Paulo": ["상파울루대학교", "상파울루대", "USP"],
  "University of Sheffield": ["셰필드대학교", "셰필드대", "쉐필드대학교", "쉐필드대"],
  "University of Southern Denmark": ["남덴마크대학교", "남부덴마크대학교", "SDU"],
  "University of the West of England(UWE Bristol)": ["서잉글랜드대학교", "UWE브리스톨", "UWE"],
  "University of Verona": ["베로나대학교", "베로나대"],
  "VinUniversity": ["빈유니버시티", "VinUni"],
  "Vorarlberg University of Applied Sciences": ["포어아를베르크응용과학대학교", "포어아를베르크대"],
};

export function normalizeUniversityAlias(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s._'’()\-·]/g, "");
}

// Conversational Korean references almost always drop the trailing "대학교"/"대"
// suffix rather than add characters in the middle (e.g. "브리스톨 지원할 때" for
// "브리스톨대학교"). Matching only the full alias with its suffix misses that
// whole class of phrasing, so every alias is also checked with the suffix
// stripped, as long as the remaining stem is long enough to stay specific.
function aliasVariants(alias: string): string[] {
  const normalized = normalizeUniversityAlias(alias);
  const stem = normalized.replace(/(대학교|대)$/, "");
  return stem.length >= 2 && stem !== normalized ? [normalized, stem] : [normalized];
}

export function universityNamesFromAliases(question: string) {
  const normalizedQuestion = normalizeUniversityAlias(question);
  return Object.entries(UNIVERSITY_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => aliasVariants(alias).some((variant) => normalizedQuestion.includes(variant))))
    .map(([name]) => name);
}
