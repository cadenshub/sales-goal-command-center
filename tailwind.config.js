/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      boxShadow: {
        glow: "0 24px 70px rgba(88, 80, 236, 0.18)",
        card: "0 18px 44px rgba(25, 33, 61, 0.08)",
      },
      colors: {
        command: {
          ink: "#101828",
          muted: "#667085",
          line: "#d8deea",
        },
      },
    },
  },
  plugins: [],
};
