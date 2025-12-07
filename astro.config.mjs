// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',       // required for Cloudflare Pages
  adapter: cloudflare(),  // enable Cloudflare
});