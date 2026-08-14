import { Link, Route, Routes } from 'react-router-dom'

function Home() {
  return (
    <main style={{ padding: 32, fontFamily: 'system-ui' }}>
      <h1 data-testid="home-title">Demo Home</h1>
      <button data-testid="cta-button">Click me</button>
      <p>Paragraph without testid for CSS-path capture.</p>
    </main>
  )
}

function About() {
  return (
    <main style={{ padding: 32, fontFamily: 'system-ui' }}>
      <h1 data-testid="about-title">About</h1>
      <ul data-testid="about-list"><li>one</li><li>two</li></ul>
    </main>
  )
}

export default function App() {
  return (
    <>
      <nav style={{ padding: 16, display: 'flex', gap: 12 }}>
        <Link data-testid="nav-home" to="/">Home</Link>
        <Link data-testid="nav-about" to="/about">About</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </>
  )
}
