export type ContinentName = "유럽" | "아시아" | "북아메리카" | "남아메리카" | "오세아니아" | "아프리카";

export type CountryProfile = {
  continent: ContinentName;
  currency: string;
  currencyName: string;
  languages: string;
  costLevel: string;
  semesterBudget: string;
  housing: string;
  transport: string;
  life: string;
};

export const countryProfiles: Record<string, CountryProfile> = {
  Austria: {
    continent: "유럽",
    currency: "EUR",
    currencyName: "유로",
    languages: "독일어, 영어",
    costLevel: "중상",
    semesterBudget: "서유럽 평균 수준",
    housing: "학생 기숙사와 WG 형태의 셰어하우스가 일반적입니다.",
    transport: "도시 교통권과 철도망이 좋고 자전거 이용도 편리합니다.",
    life: "도시 접근성과 안전한 자연환경을 함께 누릴 수 있습니다.",
  },
  Belgium: {
    continent: "유럽",
    currency: "EUR",
    currencyName: "유로",
    languages: "네덜란드어, 프랑스어, 영어",
    costLevel: "중상",
    semesterBudget: "서유럽 평균 수준",
    housing: "브뤼셀권은 지역별 월세 차이가 커서 학교 추천 주거처를 먼저 확인하는 것이 좋습니다.",
    transport: "철도와 도시 대중교통이 발달해 유럽 내 이동이 편리합니다.",
    life: "다언어 환경과 국제기구가 밀집한 도시 경험을 기대할 수 있습니다.",
  },
  Brazil: {
    continent: "남아메리카",
    currency: "BRL",
    currencyName: "브라질 헤알",
    languages: "포르투갈어",
    costLevel: "중간",
    semesterBudget: "지역과 환율에 따라 변동폭이 큼",
    housing: "셰어하우스가 일반적이며 통학 동선과 지역 안전을 함께 확인해야 합니다.",
    transport: "대도시에서는 지하철과 버스를 이용하되 야간 이동 안전에 주의가 필요합니다.",
    life: "문화 활동은 풍부하지만 기본 포르투갈어가 생활 적응에 중요합니다.",
  },
  Canada: {
    continent: "북아메리카",
    currency: "CAD",
    currencyName: "캐나다 달러",
    languages: "영어, 프랑스어",
    costLevel: "높음",
    semesterBudget: "대도시와 지방 도시 차이가 큼",
    housing: "교내 기숙사와 셰어하우스를 비교하고 겨울 난방비 포함 여부를 확인해야 합니다.",
    transport: "도시별 대중교통 체계가 다르며 장거리 이동은 항공 비중이 큽니다.",
    life: "다문화 환경과 캠퍼스 중심 학생생활이 강점입니다.",
  },
  Denmark: {
    continent: "유럽",
    currency: "DKK",
    currencyName: "덴마크 크로네",
    languages: "덴마크어, 영어",
    costLevel: "높음",
    semesterBudget: "생활비와 주거비가 높은 편",
    housing: "대학 연계 주거 공급이 제한될 수 있어 입학 확정 후 빠른 신청이 중요합니다.",
    transport: "자전거와 대중교통 중심이며 교통비 예산을 별도로 잡는 것이 좋습니다.",
    life: "영어 소통이 원활하고 안전, 복지, 워라밸 환경이 강점입니다.",
  },
  Ecuador: {
    continent: "남아메리카",
    currency: "USD",
    currencyName: "미국 달러",
    languages: "스페인어",
    costLevel: "중간",
    semesterBudget: "유럽, 북미보다 낮은 편",
    housing: "홈스테이와 사설 주거를 비교하고 캠퍼스까지 이동 시간을 확인하세요.",
    transport: "버스와 택시, 호출 서비스를 주로 이용하며 지역별 안전 정보를 확인해야 합니다.",
    life: "스페인어 몰입과 자연환경이 장점이며 고도 적응을 고려해야 합니다.",
  },
  Finland: {
    continent: "유럽",
    currency: "EUR",
    currencyName: "유로",
    languages: "핀란드어, 스웨덴어, 영어",
    costLevel: "중상",
    semesterBudget: "생활비는 높은 편이나 학생 복지로 일부 절약 가능",
    housing: "학생주택재단 주거가 사설 월세보다 저렴한 경우가 많습니다.",
    transport: "도시 교통과 장거리 철도가 안정적이며 겨울 이동 준비가 필요합니다.",
    life: "영어 사용이 편하고 자연 접근성이 좋지만 겨울 일조시간을 고려해야 합니다.",
  },
  France: {
    continent: "유럽",
    currency: "EUR",
    currencyName: "유로",
    languages: "프랑스어, 영어",
    costLevel: "중상",
    semesterBudget: "파리는 높고 지방 도시는 비교적 낮음",
    housing: "CROUS와 사설 레지던스를 함께 확인하고 CAF 주거보조 가능 여부를 검토하세요.",
    transport: "도시 교통권과 TGV가 발달했으며 지역 연계 학생 할인이 있습니다.",
    life: "기본 프랑스어가 일상생활 적응에 도움이 됩니다.",
  },
  Germany: {
    continent: "유럽",
    currency: "EUR",
    currencyName: "유로",
    languages: "독일어, 영어",
    costLevel: "중상",
    semesterBudget: "도시별 월세 차이가 큼",
    housing: "Studentenwerk 기숙사는 경쟁이 있을 수 있어 빠른 신청이 필요합니다.",
    transport: "학기권 또는 지역 교통권이 있는 경우가 많아 학교 안내를 확인해야 합니다.",
    life: "행정 절차와 거주지 등록을 미리 준비하는 것이 중요합니다.",
  },
  "Hong Kong": {
    continent: "아시아",
    currency: "HKD",
    currencyName: "홍콩 달러",
    languages: "광둥어, 영어",
    costLevel: "높음",
    semesterBudget: "주거비 비중이 높은 편",
    housing: "교내 기숙사 보장 여부가 예산에 큰 영향을 줍니다.",
    transport: "MTR, 버스, 트램을 Octopus 카드로 편리하게 이용할 수 있습니다.",
    life: "영어 기반 생활이 가능하고 도시 접근성이 매우 좋습니다.",
  },
  Italy: {
    continent: "유럽",
    currency: "EUR",
    currencyName: "유로",
    languages: "이탈리아어, 영어",
    costLevel: "중상",
    semesterBudget: "도시와 관광지 여부에 따라 차이가 큼",
    housing: "베네치아 등 관광 도시는 주거비와 통학 동선을 반드시 확인해야 합니다.",
    transport: "도시 수상교통, 버스, 철도권을 확인하고 학생 할인 여부를 검토하세요.",
    life: "도시 문화 경험이 강점이나 기본 이탈리아어가 생활에 도움이 됩니다.",
  },
  Singapore: {
    continent: "아시아",
    currency: "SGD",
    currencyName: "싱가포르 달러",
    languages: "영어, 중국어, 말레이어, 타밀어",
    costLevel: "높음",
    semesterBudget: "주거비와 외식비가 높은 편",
    housing: "기숙사 제공 여부와 보장 여부가 학교마다 다르므로 공식 housing 안내를 우선 확인해야 합니다.",
    transport: "MRT와 버스망이 촘촘하고 학생 교통카드, 할인 조건은 학교 안내를 확인하세요.",
    life: "영어 수업 접근성이 좋고 안전하지만 생활비는 아시아권 내에서도 높은 편입니다.",
  },
  Taiwan: {
    continent: "아시아",
    currency: "TWD",
    currencyName: "대만 달러",
    languages: "중국어, 영어",
    costLevel: "중간",
    semesterBudget: "동아시아 주요 도시 대비 비교적 합리적인 편",
    housing: "교내 기숙사와 교외 원룸, 셰어하우스를 함께 비교하세요.",
    transport: "MRT, 버스, 자전거 공유를 이용하기 편리합니다.",
    life: "한국 학생 후기 자료가 비교적 많고 생활 적응 장벽이 낮은 편입니다.",
  },
  "United Kingdom": {
    continent: "유럽",
    currency: "GBP",
    currencyName: "영국 파운드",
    languages: "영어",
    costLevel: "높음",
    semesterBudget: "도시와 주거 형태에 따라 차이가 큼",
    housing: "대학 기숙사는 조기 신청이 중요하며 런던, 에든버러, 브리스톨은 월세가 높은 편입니다.",
    transport: "철도와 버스가 잘 연결되어 있고 학생 할인 카드를 사용할 수 있습니다.",
    life: "다문화적인 대학 도시가 많고 동아리, 소사이어티 활동이 활발합니다.",
  },
  "United States": {
    continent: "북아메리카",
    currency: "USD",
    currencyName: "미국 달러",
    languages: "영어",
    costLevel: "높음",
    semesterBudget: "도시와 캠퍼스 주거 형태에 따라 차이가 큼",
    housing: "교내 기숙사, 아파트, 홈스테이 조건을 비교하고 보험 비용을 함께 확인해야 합니다.",
    transport: "도시별 대중교통 편차가 커서 캠퍼스 셔틀과 차량 필요 여부를 확인해야 합니다.",
    life: "캠퍼스 중심 생활이 강하고 의료보험, 비자, 예방접종 요건을 꼼꼼히 확인해야 합니다.",
  },
};

Object.assign(countryProfiles, {
  Indonesia: { continent: "아시아", currency: "IDR", currencyName: "인도네시아 루피아", languages: "인도네시아어, 영어", costLevel: "낮은 편", semesterBudget: "도시와 주거 형태에 따라 차이가 큼", housing: "대학 연계 숙소와 민간 임대를 함께 비교하세요.", transport: "도시별 교통 혼잡과 통학 시간을 확인해야 합니다.", life: "기후와 지역별 생활환경 차이를 고려하세요." },
  Japan: { continent: "아시아", currency: "JPY", currencyName: "일본 엔", languages: "일본어, 영어", costLevel: "중간", semesterBudget: "도쿄 등 대도시는 주거비 비중이 높음", housing: "대학 기숙사와 민간 학생회관의 비용과 통학 시간을 비교하세요.", transport: "철도망이 발달했지만 정기권 비용을 예산에 포함해야 합니다.", life: "도시별 주거비 차이와 기본 일본어 필요성을 고려하세요." },
  Netherlands: { continent: "유럽", currency: "EUR", currencyName: "유로", languages: "네덜란드어, 영어", costLevel: "높은 편", semesterBudget: "주거 공급 부족으로 숙소 비용 확인이 중요함", housing: "학생 주거 경쟁이 높아 입학 확정 후 빠른 신청이 필요합니다.", transport: "철도와 자전거 이용이 편리합니다.", life: "영어 접근성이 높지만 주거 확보를 우선해야 합니다." },
  Peru: { continent: "남아메리카", currency: "PEN", currencyName: "페루 솔", languages: "스페인어, 영어", costLevel: "낮은 편", semesterBudget: "지역과 생활 방식에 따라 차이가 큼", housing: "학교 추천 숙소와 홈스테이의 위치와 안전을 비교하세요.", transport: "도시별 교통과 통학 동선을 사전에 확인하세요.", life: "기본 스페인어와 지역별 안전 정보를 준비하세요." },
  Sweden: { continent: "유럽", currency: "SEK", currencyName: "스웨덴 크로나", languages: "스웨덴어, 영어", costLevel: "높은 편", semesterBudget: "주거비와 식비 비중이 높은 편", housing: "학생 주거는 조기 신청이 중요하며 배정 보장 여부를 확인해야 합니다.", transport: "도시 교통과 철도망이 안정적입니다.", life: "영어 사용이 편리하지만 겨울 생활 준비가 필요합니다." },
  Thailand: { continent: "아시아", currency: "THB", currencyName: "태국 바트", languages: "태국어, 영어", costLevel: "낮은 편", semesterBudget: "주거 위치와 생활 방식에 따라 달라짐", housing: "기숙사와 민간 콘도의 계약 조건을 비교하세요.", transport: "방콕은 철도 접근성과 통학 시간을 함께 확인하세요.", life: "기후와 현지 행정 절차를 미리 확인하세요." },
  Turkey: { continent: "아시아", currency: "TRY", currencyName: "튀르키예 리라", languages: "튀르키예어, 영어", costLevel: "낮은 편", semesterBudget: "환율 변동이 커 최신 비용 확인이 필요함", housing: "기숙사와 민간 임대의 계약 통화와 보증금을 확인하세요.", transport: "대도시는 대중교통망이 발달했습니다.", life: "환율 변동과 지역별 생활환경 차이를 고려하세요." },
  Vietnam: { continent: "아시아", currency: "VND", currencyName: "베트남 동", languages: "베트남어, 영어", costLevel: "낮은 편", semesterBudget: "주거와 식비가 비교적 낮지만 도시별 차이가 있음", housing: "대학 연계 숙소와 민간 임대의 통학 동선을 비교하세요.", transport: "교통 혼잡과 이동 시간을 고려해야 합니다.", life: "기후와 기본 현지어 표현을 준비하면 좋습니다." },
} satisfies Record<string, CountryProfile>);

export const continentOrder: ContinentName[] = ["유럽", "아시아", "북아메리카", "남아메리카", "오세아니아", "아프리카"];

function normalizeCountryName(country: string): string {
  return country
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function findCountryEntry(country: string): [string, CountryProfile] | undefined {
  const normalized = normalizeCountryName(country);
  const aliases: Record<string, string> = {
    uk: "united kingdom",
    usa: "united states",
    "united states of america": "united states",
    "hong kong sar": "hong kong",
    brasil: "brazil",
  };
  const target = aliases[normalized] ?? normalized;
  return Object.entries(countryProfiles).find(([name]) => normalizeCountryName(name) === target);
}

export function countryDisplayName(country: string): string {
  return findCountryEntry(country)?.[0] ?? country;
}

export function continentFor(country: string): ContinentName {
  return findCountryEntry(country)?.[1].continent ?? "아시아";
}

export function countryProfile(country: string): CountryProfile {
  return findCountryEntry(country)?.[1] ?? {
    continent: continentFor(country),
    currency: "",
    currencyName: "통화 정보 확인 필요",
    languages: "국가별 확인 필요",
    costLevel: "확인 필요",
    semesterBudget: "대학 및 도시별 확인 필요",
    housing: "대학의 공식 주거 안내를 확인하세요.",
    transport: "도시별 대중교통과 통학 동선을 확인하세요.",
    life: "비자, 보험, 안전, 생활 규정은 공식 출처에서 확인하세요.",
  };
}
