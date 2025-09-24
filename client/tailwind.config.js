export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        pool: {
          50:  "#f5f9fb",   // very light blue-gray
          100: "#e3edf4",   // pale slate-blue
          200: "#c2d4e3",   // muted blue
          300: "#9bb8ce",   // dusty blue
          400: "#6f97b4",   // medium subdued blue
          500: "#436f91",   // steel blue (secondary accent)
          600: "#2e4d68",   // slate navy
          700: "#243b52",   // modern navy
          800: "#1b2f42",   // deep navy
          900: "#142434",   // near-black navy
        },
      },
      boxShadow: {
        soft: "0 6px 18px rgba(20,36,52,0.25)", // subtle navy shadow
      },
      borderRadius: {
        xl2: "1rem",
      },
    },
  },
  plugins: [],
};
