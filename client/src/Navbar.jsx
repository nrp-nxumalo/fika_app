import React from 'react';

export default function Navbar() {
    return (
        <nav className="nav">
            <ul className="navList">
                <li className="navItem">
                    <a href="/" className="navLink">FIKA</a>
                </li>
                <li className="navItem navItemSecondary">
                    <a href="/about" className="navSecondaryLink">About</a>
                </li>
                <li className="navItem navItemSecondary">
                    <a href="/contact" className="navSecondaryLink">Contact</a>
                </li>
            </ul>
        </nav>
    );
}
