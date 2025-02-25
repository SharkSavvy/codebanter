/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/ui/**/*.{js,jsx,ts,tsx}',
    './ui/**/*.html'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#3b82f6',
          dark: '#2563eb'
        }
      }
    }
  },
  plugins: []
}