# Notice

flowdeck is released under the MIT License (see LICENSE). It is built from the MIT-licensed mods below; their copyright notices follow, and the MIT permission notice at the end applies to each of them.

## savvy-flow and savvy-progress (claude-kit)
MIT License. Copyright (c) 2026 johnnyvizz. Source: https://github.com/JohnnyVizz/claude-kit
The orchestrated flow (skill and the five worker agents), the band above the prompt, and the agents panel come from these two mods. The worker sprite is flowdeck's own.

## context-bar (claude-code-mods)
MIT License. Copyright (c) 2026 Hamza Zafar. Source: https://github.com/hamzafer/claude-code-mods
The context window reading, bar and legend in hooks/context.ts are ported from it.

## plan-progress (zycck-mods) 0.8.2
MIT License. Copyright (c) 2026 Kirill Serditov. Source: https://github.com/zycck/claude-mods
The plan model in hooks/plan.ts is ported from it.

## ribbon
MIT License. Copyright (c) 2026 Jay E | RoboNuggets (robonuggets.com). Source: https://github.com/robonuggets/ribbon
The prompt-cache WARM/COLD idea and its price and cost method (the 1-hour cache write at 2x input, a cache read at the read price, the model matched by family) come from it, reimplemented in hooks/cache.ts and hooks/cache-view.tsx. Its drawings and its embedded font are not used.

## Cache Bell
MIT License. Copyright (c) 2026 FEO digital agency s.r.o. Source: https://github.com/hollerbell/cache-bell
Keep warm follows its renewal method (a tool-less side request over the session's transcript before the cache expires, a small number of renewals per idle stretch), reimplemented in hooks/cache.ts and hooks/register.tsx; no code was copied.

---

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
