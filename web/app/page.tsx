import Link from "next/link";
import { BrandMark } from "./ui/LocalMedia";

export default function Home() {
  return (
    <main className="path-home">
      <div className="path-brand">
        <BrandMark className="path-brand-mark" />
        <b>SKKU Exchange Atlas</b>
      </div>

      <section className="path-intro">
        <p>START YOUR EXCHANGE</p>
        <h1>
          지금 나에게 맞는 탐색부터
          <br />
          시작해 보세요.
        </h1>
        <span>아직 목적지가 없어도, 이미 조건이 정해져 있어도 괜찮아요.</span>
      </section>

      <div className="path-options">
        <Link href="/explore" className="path-card path-undecided">
          <small>EXPLORE THE WORLD</small>
          <span className="path-number">01</span>
          <div>
            <h2>
              아직 교환 여부를
              <br />
              고민하고 있어요
            </h2>
            <p>
              대학과 국가의 생활 환경부터 둘러보고
              <br />
              나에게 끌리는 목적지를 발견해 보세요.
            </p>
            <b>세계 지도에서 탐색하기 →</b>
          </div>
        </Link>

        <Link href="/filter" className="path-card path-decided">
          <small>FIND MY UNIVERSITY</small>
          <span className="path-number">02</span>
          <div>
            <h2>
              교환 여부를
              <br />
              결정했어요
            </h2>
            <p>
              관심 대륙·전공·파견 학기·어학 성적으로
              <br />
              지원할 대학을 빠르게 좁혀 보세요.
            </p>
            <b>내 조건으로 찾기 →</b>
          </div>
        </Link>
      </div>
    </main>
  );
}
