import React, { useEffect, useRef, useState } from 'react';

const NAV_LINKS = [
    { href: '/about', label: 'About' },
    { href: '/operators/myciti', label: 'MyCiTi' },
    { href: '/operators/golden-arrow', label: 'Golden Arrow' },
    { href: '/areas', label: 'Areas' },
    { href: '/saved-timetables', label: 'Saved' },
    { href: '/contact', label: 'Contact' },
];

export default function Navbar() {
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const navRef = useRef(null);

    useEffect(() => {
        if (!isMenuOpen) return undefined;

        const closeMenu = (event) => {
            if (event.key === 'Escape' || !navRef.current?.contains(event.target)) {
                setIsMenuOpen(false);
            }
        };

        document.addEventListener('keydown', closeMenu);
        document.addEventListener('pointerdown', closeMenu);

        return () => {
            document.removeEventListener('keydown', closeMenu);
            document.removeEventListener('pointerdown', closeMenu);
        };
    }, [isMenuOpen]);

    return (
        <nav className="nav" ref={navRef} aria-label="Main navigation">
            <div className="navBar">
                <a href="/" className="navLink">FIKA</a>
                <button
                    type="button"
                    className="navMenuButton"
                    aria-expanded={isMenuOpen}
                    aria-controls="nav-menu"
                    aria-label={isMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
                    onClick={() => setIsMenuOpen((open) => !open)}
                >
                    <span className="navMenuIcon" aria-hidden="true" />
                </button>
                <ul id="nav-menu" className={`navList${isMenuOpen ? ' isOpen' : ''}`}>
                    {NAV_LINKS.map(({ href, label }) => (
                        <li className="navItem navItemSecondary" key={href}>
                            <a href={href} className="navSecondaryLink">{label}</a>
                        </li>
                    ))}
                </ul>
            </div>
        </nav>
    );
}
