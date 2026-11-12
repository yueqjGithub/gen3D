const creationAction = /(?:生成|创建|制作|设计|建模|构建|做|造|generate|create|make|build|design|modeling)/i;
const assetTarget = /(?:\b3d\b|三维|模型|资产|blender|网格|mesh|道具|角色|场景|物体|椅|树|房|车|武器|动物|植物|character|prop|scene|object|asset)/i;
const informationRequest = /(?:如何|怎么|教程|解释|介绍|是什么|what\s+is|how\s+to|how\s+do|explain|teach)/i;
const negatedCreation = /(?:不要|别|禁止|不需要|无需|不必|don't|do not|not)\s*(?:(?:\w+|我|给我|帮我|为我)\s*){0,3}(?:生成|创建|制作|设计|建模|构建|做|造|generate|create|make|build|design|modeling)/i;
const capabilityQuestion = /^(?:你能|你可以|你是否能|能不能|能否|可以帮我|can\s+you|could\s+you|would\s+you|do\s+you)\s*(?:(?:帮我|为我)\s*)?(?:生成|创建|制作|设计|建模|构建|做|造|generate|create|make|build|design|modeling)\s*(?:一个|一件|一款|a|an)?\s*(?:(?:3d|三维)\s*)?(?:模型|资产|models?|assets?)\s*(?:吗|呢)?[?？.!。]*$/i;

export function hasExplicitAssetGenerationIntent(text: string): boolean {
  const normalizedText = text.trim();
  return normalizedText.length > 0
    && !negatedCreation.test(normalizedText)
    && !capabilityQuestion.test(normalizedText)
    && !informationRequest.test(normalizedText)
    && creationAction.test(normalizedText)
    && assetTarget.test(normalizedText);
}
