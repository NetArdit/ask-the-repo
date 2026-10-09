# Third-party notices

AskTheRepo's own dependencies are listed in `package.json` and installed from npm under their own licences (mostly MIT, with some Apache-2.0, ISC, BSD, 0BSD and CC-BY-4.0 packages, and `tree-sitter-wasms`, which is under the Unlicense; TypeScript is Apache-2.0 and used only at build time).

A production build copies three compiled grammar files from the `tree-sitter-wasms` package into its output (`tree-sitter-javascript.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`) together with the `web-tree-sitter` runtime. Those binaries are built from the projects below, whose notices are reproduced here because the binaries are redistributed with a build.

The copyright lines were read from the upstream repositories' `LICENSE` files on their default branches. Which upstream versions `tree-sitter-wasms` 0.1.13 was compiled from has not been checked.

## tree-sitter-javascript

The MIT License (MIT)

Copyright (c) 2014 Max Brunsfeld

## tree-sitter-typescript (typescript and tsx grammars)

The MIT License (MIT)

Copyright (c) 2017 Max Brunsfeld

## web-tree-sitter

The MIT License (MIT)

Copyright (c) 2018-2024 Max Brunsfeld

## Licence text (MIT), applying to each of the three above

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## sindresorhus/slugify (screenshots only)

The browser-test screenshots in `e2e/artifacts/` show short excerpts of `sindresorhus/slugify` at commit `3b17b2e84b97624a683aafaa38184bf2746fab22`, which the application displayed while being tested. The repository's `license` file at that commit is the MIT licence, `Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)`. No slugify code is part of AskTheRepo.
