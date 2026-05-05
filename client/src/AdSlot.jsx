import React, { useEffect } from 'react';

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
      window.adsbygoogle = window.adsbygoogle || [];
      window.adsbygoogle.push({});
    } catch (error) {
      console.error('AdSense slot failed to initialize:', error);
    }
  }, [adClient, adSlot, hasAdsenseConfig]);

  if (hasAdsenseConfig) {
    return (
      <div className={`ad-slot ad-slot-adsense ${className}`.trim()} aria-label="Advertisement">
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
    <div className={`ad-slot ${className}`.trim()} aria-label="Advertisement">
      <span>Advertisement</span>
      {format && <small>{format}</small>}
    </div>
  );
}
