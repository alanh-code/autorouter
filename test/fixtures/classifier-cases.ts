import type {RequestTaskCategory} from "../../src/core/request-classifier.ts";

// Synthetic draft labels for human review, not independently validated ground truth.
// These are development cases, not a held-out acceptance set.
export const classifierCases: ReadonlyArray<{
  id: string; input: string; expected: RequestTaskCategory; rationale: string;
}> = [
  {id: "c01", input: "Write a Python function that removes duplicate strings while preserving order.", expected: "coding", rationale: "The deliverable is a function, not general reasoning."},
  {id: "c02", input: "Explain why this expression returns false: Number.isNaN('hello').", expected: "coding", rationale: "Explaining language behavior is code explanation."},
  {id: "c03", input: "Fix this loop so it visits every item: for (let i = 1; i < items.length; i++) visit(items[i]);", expected: "coding", rationale: "The requested outcome is debugging code."},
  {id: "c04", input: "Write SQL to count orders per customer. Do not draw a chart.", expected: "coding", rationale: "Data processing code is not data visualization."},
  {id: "c05", input: "Use the file and test tools to fix a failing date parser and run its tests.", expected: "coding", rationale: "Code repair remains coding even with multiple tool calls."},
  {id: "c06", input: "做代码 review，检查这个条件是否正确：if (age = 18) allow();", expected: "coding", rationale: "Reviewing source code is coding regardless of language."},
  {id: "r01", input: "A box has three red balls and two blue balls. What is the probability of drawing two red balls without replacement?", expected: "general_reasoning", rationale: "A mathematical answer is requested, not code."},
  {id: "r02", input: "Compare the tradeoffs of renting versus buying a bicycle for a two-month visit.", expected: "general_reasoning", rationale: "The deliverable is comparative analysis."},
  {id: "r03", input: "Plan the milestones for launching a website. Do not build any pages or write code.", expected: "general_reasoning", rationale: "Planning about a website is distinct from building one."},
  {id: "r04", input: "解释为什么相关性不能证明因果关系，用一个生活例子。", expected: "general_reasoning", rationale: "A conceptual explanation is requested."},
  {id: "w01", input: "Build a complete responsive home page for a neighborhood bakery with a menu, opening hours, and contact section.", expected: "website", rationale: "The primary artifact is a complete web page."},
  {id: "w02", input: "Redesign an entire museum website, including the home, exhibitions, and visit pages.", expected: "website", rationale: "Multiple complete pages define the requested artifact."},
  {id: "w03", input: "用 HTML 和 CSS 制作一个完整的摄影作品展示网页。", expected: "website", rationale: "Website construction takes precedence over generic coding."},
  {id: "u01", input: "Implement an accessible dropdown menu component with keyboard navigation.", expected: "ui_components", rationale: "A single reusable interface component is requested."},
  {id: "u02", input: "Redesign only the checkout button, with loading, disabled, and success states.", expected: "ui_components", rationale: "The scope is one component rather than a full page."},
  {id: "u03", input: "Create a reusable date picker for a booking website; do not build the website itself.", expected: "ui_components", rationale: "The website context does not change the component deliverable."},
  {id: "g01", input: "Build a playable browser memory-card matching game with scoring.", expected: "game_development", rationale: "A playable game is more specific than a website."},
  {id: "g02", input: "Modify the platformer so the player can double-jump and collect coins.", expected: "game_development", rationale: "The requested change concerns gameplay mechanics."},
  {id: "g03", input: "制作一个简单的文字冒险游戏，玩家可以选择不同路线。", expected: "game_development", rationale: "Text-only games still have game development as their primary outcome."},
  {id: "v01", input: "Create a line chart of monthly rainfall from this data: Jan 20, Feb 35, Mar 28.", expected: "data_visualization", rationale: "The deliverable visually represents numerical data."},
  {id: "v02", input: "Write plotting code to visualize a distribution of response times as a histogram.", expected: "data_visualization", rationale: "The visualization outcome takes precedence over its code implementation."},
  {id: "v03", input: "把各地区销售额画成柱状图，并标出最高的一项。", expected: "data_visualization", rationale: "The primary request is a chart."},
  {id: "d01", input: "Create a 3D scene of a glass vase on a wooden table with realistic lighting.", expected: "three_d", rationale: "A 3D scene is the requested artifact."},
  {id: "d02", input: "Write rendering code for a rotating 3D torus, without any gameplay.", expected: "three_d", rationale: "3D rendering is more specific than generic coding."},
  {id: "a01", input: "Use the calendar and email tools to find a free meeting slot, send invitations, and verify that they were delivered.", expected: "agentic", rationale: "This is a multi-step external operational workflow."},
  {id: "a02", input: "Use the inventory and purchasing tools to check stock, submit replenishment requests, and verify their status.", expected: "agentic", rationale: "External actions define the outcome rather than code or analysis."},
  {id: "a03", input: "用文件工具找出下载目录里的发票，把它们按月份归档，然后确认每个文件都已移动。", expected: "agentic", rationale: "The user asks for a tool-executed operational workflow."},
  {id: "o01", input: "Translate 'The train arrives tomorrow morning' into French.", expected: "other", rationale: "Translation is outside the specialized task categories."},
  {id: "o02", input: "Hello! Hope you are having a pleasant afternoon.", expected: "other", rationale: "Casual conversation does not ask for a specialized outcome."},
  {id: "o03", input: "Write a short poem about autumn leaves.", expected: "other", rationale: "Creative prose is outside the defined specialized categories."}
];
