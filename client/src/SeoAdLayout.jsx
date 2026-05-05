import React from 'react';
import AdSlot from './AdSlot';

export default function SeoAdLayout({ children }) {
  return (
    <div className="seo-ad-layout">
      <aside className="seo-ad-rail seo-ad-rail-left">
        <AdSlot
          adClient="ca-pub-6988683138579622"
          adFormat="autorelaxed"
          adSlot="2670138789"
          className="ad-slot-seo-rail"
        />
      </aside>
      {children}
      <aside className="seo-ad-rail seo-ad-rail-right">
        <AdSlot
          adClient="ca-pub-6988683138579622"
          adFormat="autorelaxed"
          adSlot="2670138789"
          className="ad-slot-seo-rail"
        />
      </aside>
    </div>
  );
}
