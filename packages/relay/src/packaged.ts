// Whether this code runs as the published command (ADR 0028). The relay's
// build (scripts/build.ts) defines TABDOCK_PACKAGED as true in the bundle it
// writes, and nothing else does, so the sources a checkout runs, the tests and
// the container image (which runs the sources too) all see false. It is never
// guessed from a path: a checkout can sit under a directory named
// node_modules, and an install can sit anywhere.
//
// Four things follow from it: the argument worker's file name, no implicit
// .env file, the banner's pointer to the deploy guide by URL, and no
// comparison of the token directory with a checkout the package does not have.

declare const TABDOCK_PACKAGED: boolean | undefined;

export const PACKAGED: boolean = typeof TABDOCK_PACKAGED === 'boolean' && TABDOCK_PACKAGED;

/** The repository, as package.json names it, for links a package cannot resolve locally. */
export const REPOSITORY_URL = 'https://github.com/PaulMRamirez/tabdock';

/** The guide the banner sends people to for Claude on the web, desktop or phone. */
export const DEPLOY_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/deploy.md`;
