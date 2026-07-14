import Link from "next/link";

export function Header() {
  return <header className="site-header">
    <Link className="brand" href="/"><span className="brand-mark">S</span><span>SKKU<br/><b>Exchange Atlas</b></span></Link>
    <nav aria-label="주요 메뉴"><Link href="/explore">세계지도 탐색</Link><Link href="/filter">조건 탐색</Link><Link href="/universities">대학 목록</Link><Link href="/compare">대학 비교</Link><a href="https://www.skku.edu" target="_blank" rel="noreferrer">SKKU</a></nav>
  </header>;
}
