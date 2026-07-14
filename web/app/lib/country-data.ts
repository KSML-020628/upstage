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
  "United Kingdom": { continent:"유럽", currency:"GBP", currencyName:"영국 파운드", languages:"영어", costLevel:"높음", semesterBudget:"도시와 주거 형태에 따라 편차가 큼", housing:"대학 기숙사는 조기 신청이 중요하며 런던·에든버러·브리스틀은 임대료가 높은 편이에요.", transport:"도시간 철도와 버스가 잘 연결되어 있고 학생 할인 카드를 활용할 수 있어요.", life:"다문화적인 대학 도시가 많고 학기 중 동아리·소사이어티 활동이 활발해요." },
  "Hong Kong": { continent:"아시아", currency:"HKD", currencyName:"홍콩 달러", languages:"광둥어·영어", costLevel:"높음", semesterBudget:"주거비 비중이 특히 높은 편", housing:"교내 기숙사 확보 여부가 전체 예산에 큰 영향을 줘요.", transport:"MTR·버스·트램이 촘촘하고 옥토퍼스 카드로 대부분 이동할 수 있어요.", life:"고밀도 도심과 자연이 가까우며 영어로 대학 생활이 가능한 국제도시예요." },
  "Belgium": { continent:"유럽", currency:"EUR", currencyName:"유로", languages:"네덜란드어·프랑스어·독일어", costLevel:"중상", semesterBudget:"서유럽 평균 수준", housing:"학생 레지던스와 개인 스튜디오가 있으며 브뤼셀은 지역별 임대료 차이가 커요.", transport:"철도로 주변 유럽 국가 이동이 편리하고 학생 교통권을 확인할 가치가 있어요.", life:"다언어 환경과 국제기구가 밀집해 있어 국제적인 생활 경험을 할 수 있어요." },
  "France": { continent:"유럽", currency:"EUR", currencyName:"유로", languages:"프랑스어", costLevel:"중상", semesterBudget:"파리는 높고 지방 대학 도시는 비교적 낮음", housing:"CROUS와 사설 레지던스를 함께 살펴보고 CAF 주거보조 신청 가능 여부를 확인하세요.", transport:"도시 대중교통과 TGV가 발달해 있으며 지역·연령별 할인 제도가 다양해요.", life:"지역마다 문화와 생활비 차이가 크며 기본 프랑스어가 일상생활에 도움이 돼요." },
  "Austria": { continent:"유럽", currency:"EUR", currencyName:"유로", languages:"독일어", costLevel:"중상", semesterBudget:"서유럽 평균 수준", housing:"학생 기숙사와 WG 형태의 셰어하우스가 일반적이에요.", transport:"도시 교통권과 철도망이 좋고 자전거 이용도 편리한 편이에요.", life:"도시 접근성과 알프스 자연환경을 함께 누릴 수 있어요." },
  "Denmark": { continent:"유럽", currency:"DKK", currencyName:"덴마크 크로네", languages:"덴마크어·영어", costLevel:"높음", semesterBudget:"식비와 외식비가 높은 편", housing:"대학 연계 주거도 공급이 제한될 수 있어 입학 확정 후 빠르게 신청해야 해요.", transport:"자전거와 대중교통 중심이며 교통비 예산을 별도로 잡는 것이 좋아요.", life:"영어 소통이 원활하고 안전·복지·워크라이프 환경이 강점이에요." },
  "Finland": { continent:"유럽", currency:"EUR", currencyName:"유로", languages:"핀란드어·스웨덴어·영어", costLevel:"중상", semesterBudget:"외식은 높지만 학생 복지로 일부 절약 가능", housing:"학생주택재단 주거가 일반 사설 임대보다 저렴한 경우가 많아요.", transport:"도시 교통과 장거리 철도가 안정적이며 겨울 이동 준비가 필요해요.", life:"영어 사용이 편하고 자연 접근성이 좋지만 겨울 일조시간과 방한 준비를 고려해야 해요." },
  "Ecuador": { continent:"남아메리카", currency:"USD", currencyName:"미국 달러", languages:"스페인어", costLevel:"중저", semesterBudget:"유럽·북미보다 낮은 편", housing:"홈스테이와 사설 주거를 비교하고 캠퍼스까지의 이동시간을 확인하세요.", transport:"도시 버스와 택시·호출 서비스를 이용하며 지역별 안전 정보를 확인해야 해요.", life:"스페인어 몰입과 다양한 자연환경이 장점이며 고도 적응과 안전 수칙이 중요해요." },
  "Canada": { continent:"북아메리카", currency:"CAD", currencyName:"캐나다 달러", languages:"영어·프랑스어", costLevel:"높음", semesterBudget:"대도시와 지방 도시의 차이가 큼", housing:"교내 기숙사와 셰어하우스를 비교하고 겨울 난방비 포함 여부를 확인하세요.", transport:"도시별 대중교통 체계가 다르며 장거리 이동은 항공 비중이 커요.", life:"다문화 환경과 캠퍼스 중심 학생생활이 강점이며 겨울 의류 예산이 필요해요." },
  "Brazil": { continent:"남아메리카", currency:"BRL", currencyName:"브라질 헤알", languages:"포르투갈어", costLevel:"중저", semesterBudget:"지역과 환율에 따라 변동 폭이 큼", housing:"대학가 셰어하우스가 일반적이며 통학 동선과 지역 안전을 함께 확인하세요.", transport:"대도시에서는 지하철·버스를 이용하고 야간 이동 안전에 유의해야 해요.", life:"문화·음식·학생 활동이 활발하며 기본 포르투갈어가 생활 적응에 크게 도움이 돼요." },
};

export const continentOrder: ContinentName[] = ["유럽", "아시아", "북아메리카", "남아메리카", "오세아니아", "아프리카"];

export function continentFor(country: string): ContinentName {
  return countryProfiles[country]?.continent ?? "아시아";
}

export function countryProfile(country: string): CountryProfile {
  return countryProfiles[country] ?? {
    continent: continentFor(country), currency:"USD", currencyName:"현지 통화", languages:"국가별 확인 필요", costLevel:"확인 필요", semesterBudget:"대학 및 도시에 따라 확인 필요", housing:"대학의 공식 주거 안내를 확인하세요.", transport:"도시별 대중교통과 통학 동선을 확인하세요.", life:"비자·보험·치안·생활 규정을 공식 출처에서 확인하세요.",
  };
}
