import Script from 'next/script';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const onStart = () => {
    window.gtag('event', 'start_reading', {
      source: 'homepage_hero',
      email: user.email,
      page_type: 'tool',
    });
  };
  return (<html lang="en"><body>{children}</body></html>);
}
export function track() {
  window.dataLayer.push({ event: 'session_start', question: q, surface: 'home' });
}
