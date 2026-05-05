import React from 'react';
import SiteFooter from './SiteFooter';

export const INFO_PAGES = {
  '/about': {
    title: 'About Fika Timetables',
    eyebrow: 'About',
    body: [
      'Fika Timetables helps Cape Town commuters search Golden Arrow and MyCiTi bus timetables in one place.',
      'The site is designed for quick route lookup, readable timetable views, and offline access to routes you view often.',
      'More South African operators, cities, and provinces are planned as reliable timetable data becomes available.',
    ],
  },
  '/contact': {
    title: 'Contact Fika Timetables',
    eyebrow: 'Contact',
    body: [
      'For timetable feedback, data corrections, accessibility issues, or general enquiries, contact the Fika team.',
      'Email: hello@fikatimetables.co.za',
      'Please include the agency, route name, direction, and stop details when reporting timetable data issues.',
    ],
  },
  '/privacy-policy': {
    title: 'Privacy Policy',
    eyebrow: 'Privacy',
    body: [
      'Fika Timetables stores viewed and saved timetables in your browser using IndexedDB so selected timetable data can be available offline.',
      'The site does not require user accounts. If analytics or advertising are added, this policy should disclose the cookies, identifiers, and third-party services used.',
      'Future AdSense ads may use cookies or similar technologies from Google to serve and measure ads, subject to your region and consent choices.',
    ],
  },
  '/terms': {
    title: 'Terms and Disclaimer',
    eyebrow: 'Terms',
    body: [
      'Fika Timetables is provided as a commuter-friendly timetable viewer. Always confirm critical trips with the relevant transport operator.',
      'Timetable data can change, and Fika does not guarantee that every route, stop, or trip time is complete or current.',
      'You may use the site for personal timetable lookup. Automated scraping or abusive request patterns are not permitted.',
    ],
  },
};

export default function InfoPage({ page }) {
  return (
    <main className="info-page">
      <section className="info-panel">
        <p className="info-eyebrow">{page.eyebrow}</p>
        <h1>{page.title}</h1>
        {page.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </section>
      <SiteFooter />
    </main>
  );
}
