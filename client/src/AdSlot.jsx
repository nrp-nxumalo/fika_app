import React, { useEffect } from 'react';

const ADSENSE_SCRIPT_ID = 'fika-adsense-script';

const ensureAdsenseScript = (adClient) => {
  if (typeof document === 'undefined') {
    return;
  }

  if (document.getElementById(ADSENSE_SCRIPT_ID)) {
    return;
  }

  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.id = ADSENSE_SCRIPT_ID;
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(adClient)}`;
  document.head.appendChild(script);
};

export default function AdSlot({
  adClient,
  adFormat,
  adLayout,
  adSlot,
  className = '',
  format,
  textAlign,
}) {
  const hasAdsenseConfig = Boolean(adClient && adSlot);

  useEffect(() => {
    if (!hasAdsenseConfig || typeof window === 'undefined') {
      return;
    }

    try {
      ensureAdsenseScript(adClient);
      window.adsbygoogle = window.adsbygoogle || [];
      window.adsbygoogle.push({});
    } catch (error) {
      console.error('AdSense slot failed to initialize:', error);
    }
  }, [adClient, adSlot, hasAdsenseConfig]);

  if (hasAdsenseConfig) {
    return (
      <div className={`ad-slot ad-slot-adsense ${className}`.trim()} aria-label="Advertisements">
        <div className="ad-slot-label">Advertisements</div>
        <ins
          className="adsbygoogle"
          style={{
            display: 'block',
            ...(textAlign ? { textAlign } : {}),
          }}
          data-ad-layout={adLayout}
          data-ad-format={adFormat}
          data-ad-client={adClient}
          data-ad-slot={adSlot}
        />
      </div>
    );
  }

  return (
    <div className={`ad-slot ${className}`.trim()} aria-label="Advertisements">
      <span>Advertisements</span>
      {format && <small>{format}</small>}
    </div>
  );
}
