/** @type {import('lint-staged').Config} */
export default {
  'src/**/*.{js,jsx,ts,tsx}': ['node scripts/add-copyright-header.js'],
}
