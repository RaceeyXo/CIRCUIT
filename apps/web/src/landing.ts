import "./tailwind.css";

// Pill nav becomes a floating capsule once the page scrolls.
const nav = document.querySelector<HTMLElement>(".nav");
const onScroll = () => nav?.classList.toggle("floating", window.scrollY > 24);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();
