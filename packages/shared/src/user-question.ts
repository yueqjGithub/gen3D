import { z } from 'zod';

/** 一个问题配几个可选答案；自定义答案由用户在桌面端填写。 */
export const userQuestionSchema = z.object({
  question: z.string().trim().min(1).max(500),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300),
  }).strict()).min(2).max(4),
}).strict();

export const userAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(2000),
}).strict();

export type UserQuestion = z.infer<typeof userQuestionSchema>;
export type UserAnswer = z.infer<typeof userAnswerSchema>;
