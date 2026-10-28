import { Type } from 'typebox';

/** Shared tool contract; implementation remains in the Node raster boundary. */
export function imageResizeSchema() {
  return Type.Object({
    width: Type.Integer({ minimum: 1, maximum: 8192 }),
    height: Type.Integer({ minimum: 1, maximum: 8192 }),
    fit: Type.Optional(Type.Union([Type.Literal('contain'), Type.Literal('cover')], {
      description: 'contain (default) preserves the entire image with transparent padding; cover crops to fill.',
    })),
  }, { additionalProperties: false,
    description: 'Optional local resize to exact dimensions (at most 40 million pixels). Saves a PNG copy; preserves the original. Separate from provider size controls.' });
}
