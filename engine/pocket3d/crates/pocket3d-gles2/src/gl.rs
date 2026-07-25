//! Raw GLES2 resource ownership and submission.
//!
//! This module is compiled only for the custom Symbian target
//! (`target_os = "none"`). Ordinary host tests never reference GL symbols.

use alloc::vec;
use alloc::vec::Vec;
use core::ffi::{c_char, c_void};
use core::mem::size_of;
use core::ptr;

use pocket3d_bsp::cooked::CookedMap;
use pocket3d_bsp::types::SurfaceKind;

use crate::mesh::{BlendMode, ColorVertex};
use crate::world::{
    index_buffer_offset, vertex_buffer_offset, FrameOptions, GlesWorldVertex, RenderError,
    Viewport, WorldCounters,
};

type GLenum = u32;
type GLuint = u32;
type GLint = i32;
type GLsizei = i32;
type GLboolean = u8;
type GLbitfield = u32;
type GLfloat = f32;
type GLsizeiptr = isize;

const GL_FALSE: GLboolean = 0;
const GL_TRUE: GLboolean = 1;
const GL_FLOAT: GLenum = 0x1406;
const GL_UNSIGNED_BYTE: GLenum = 0x1401;
const GL_UNSIGNED_SHORT: GLenum = 0x1403;
const GL_TRIANGLES: GLenum = 0x0004;
const GL_ARRAY_BUFFER: GLenum = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER: GLenum = 0x8893;
const GL_STATIC_DRAW: GLenum = 0x88e4;
const GL_DYNAMIC_DRAW: GLenum = 0x88e8;
const GL_VERTEX_SHADER: GLenum = 0x8b31;
const GL_FRAGMENT_SHADER: GLenum = 0x8b30;
const GL_COMPILE_STATUS: GLenum = 0x8b81;
const GL_LINK_STATUS: GLenum = 0x8b82;
const GL_TEXTURE_2D: GLenum = 0x0de1;
const GL_TEXTURE0: GLenum = 0x84c0;
const GL_RGBA: GLenum = 0x1908;
const GL_LINEAR: GLint = 0x2601;
const GL_REPEAT: GLint = 0x2901;
const GL_CLAMP_TO_EDGE: GLint = 0x812f;
const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
const GL_TEXTURE_WRAP_S: GLenum = 0x2802;
const GL_TEXTURE_WRAP_T: GLenum = 0x2803;
const GL_UNPACK_ALIGNMENT: GLenum = 0x0cf5;
const GL_BLEND: GLenum = 0x0be2;
const GL_ONE: GLenum = 1;
const GL_SRC_ALPHA: GLenum = 0x0302;
const GL_COLOR_BUFFER_BIT: GLbitfield = 0x0000_4000;
const GL_DEPTH_BUFFER_BIT: GLbitfield = 0x0000_0100;
const GL_SCISSOR_TEST: GLenum = 0x0c11;
const GL_DEPTH_TEST: GLenum = 0x0b71;
const GL_CULL_FACE: GLenum = 0x0b44;
const GL_LEQUAL: GLenum = 0x0203;
const GL_MAX_TEXTURE_SIZE: GLenum = 0x0d33;
const GL_NO_ERROR: GLenum = 0;

unsafe extern "C" {
    fn glActiveTexture(texture: GLenum);
    fn glAttachShader(program: GLuint, shader: GLuint);
    fn glBindAttribLocation(program: GLuint, index: GLuint, name: *const c_char);
    fn glBindBuffer(target: GLenum, buffer: GLuint);
    fn glBindTexture(target: GLenum, texture: GLuint);
    fn glBlendFunc(source: GLenum, destination: GLenum);
    fn glBufferData(target: GLenum, size: GLsizeiptr, data: *const c_void, usage: GLenum);
    fn glBufferSubData(target: GLenum, offset: isize, size: GLsizeiptr, data: *const c_void);
    fn glClear(mask: GLbitfield);
    fn glClearColor(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat);
    fn glClearDepthf(depth: GLfloat);
    fn glCompileShader(shader: GLuint);
    fn glCreateProgram() -> GLuint;
    fn glCreateShader(kind: GLenum) -> GLuint;
    fn glDeleteBuffers(count: GLsizei, buffers: *const GLuint);
    fn glDeleteProgram(program: GLuint);
    fn glDeleteShader(shader: GLuint);
    fn glDeleteTextures(count: GLsizei, textures: *const GLuint);
    fn glDepthFunc(function: GLenum);
    fn glDepthMask(flag: GLboolean);
    fn glDisable(capability: GLenum);
    fn glDisableVertexAttribArray(index: GLuint);
    fn glDrawArrays(mode: GLenum, first: GLint, count: GLsizei);
    fn glDrawElements(mode: GLenum, count: GLsizei, kind: GLenum, indices: *const c_void);
    fn glEnable(capability: GLenum);
    fn glEnableVertexAttribArray(index: GLuint);
    fn glGenBuffers(count: GLsizei, buffers: *mut GLuint);
    fn glGenTextures(count: GLsizei, textures: *mut GLuint);
    fn glGetError() -> GLenum;
    fn glGetIntegerv(parameter: GLenum, value: *mut GLint);
    fn glGetProgramiv(program: GLuint, parameter: GLenum, value: *mut GLint);
    fn glGetShaderiv(shader: GLuint, parameter: GLenum, value: *mut GLint);
    fn glGetUniformLocation(program: GLuint, name: *const c_char) -> GLint;
    fn glLinkProgram(program: GLuint);
    fn glPixelStorei(parameter: GLenum, value: GLint);
    fn glShaderSource(
        shader: GLuint,
        count: GLsizei,
        source: *const *const c_char,
        length: *const GLint,
    );
    fn glTexImage2D(
        target: GLenum,
        level: GLint,
        internal_format: GLint,
        width: GLsizei,
        height: GLsizei,
        border: GLint,
        format: GLenum,
        kind: GLenum,
        pixels: *const c_void,
    );
    fn glTexParameteri(target: GLenum, parameter: GLenum, value: GLint);
    fn glUniform1i(location: GLint, value: GLint);
    fn glUniformMatrix4fv(
        location: GLint,
        count: GLsizei,
        transpose: GLboolean,
        values: *const GLfloat,
    );
    fn glUseProgram(program: GLuint);
    fn glVertexAttribPointer(
        index: GLuint,
        size: GLint,
        kind: GLenum,
        normalized: GLboolean,
        stride: GLsizei,
        pointer: *const c_void,
    );
    fn glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
}

const VERTEX_SHADER: &[u8] = b"
attribute highp vec3 a_position;
attribute mediump vec2 a_uv;
attribute lowp vec4 a_color;
uniform highp mat4 u_view_proj;
varying mediump vec2 v_uv;
varying lowp vec4 v_color;
void main() {
    gl_Position = u_view_proj * vec4(a_position, 1.0);
    v_uv = a_uv;
    v_color = a_color;
}
\0";

const OPAQUE_FRAGMENT_SHADER: &[u8] = b"
precision mediump float;
uniform sampler2D u_texture;
varying mediump vec2 v_uv;
varying lowp vec4 v_color;
void main() {
    gl_FragColor = texture2D(u_texture, v_uv) * v_color;
}
\0";

const MASKED_FRAGMENT_SHADER: &[u8] = b"
precision mediump float;
uniform sampler2D u_texture;
varying mediump vec2 v_uv;
varying lowp vec4 v_color;
void main() {
    lowp vec4 texel = texture2D(u_texture, v_uv);
    if (texel.a < 0.25) discard;
    gl_FragColor = texel * v_color;
}
\0";

const ATTR_POSITION: &[u8] = b"a_position\0";
const ATTR_UV: &[u8] = b"a_uv\0";
const ATTR_COLOR: &[u8] = b"a_color\0";
const UNIFORM_VIEW_PROJ: &[u8] = b"u_view_proj\0";
const UNIFORM_TEXTURE: &[u8] = b"u_texture\0";

const COLOR_VERTEX_SHADER: &[u8] = b"
attribute lowp vec4 a_color;
attribute highp vec3 a_position;
uniform highp mat4 u_model;
uniform highp mat4 u_view_proj;
varying lowp vec4 v_color;
void main() {
    gl_Position = u_view_proj * u_model * vec4(a_position, 1.0);
    v_color = a_color;
}
\0";

const COLOR_FRAGMENT_SHADER: &[u8] = b"
precision mediump float;
varying lowp vec4 v_color;
void main() {
    gl_FragColor = v_color;
}
\0";

const UNIFORM_MODEL: &[u8] = b"u_model\0";

struct Program {
    name: GLuint,
    view_proj: GLint,
}

struct ColorProgram {
    name: GLuint,
    model: GLint,
    view_proj: GLint,
}

impl ColorProgram {
    unsafe fn create() -> Result<Self, RenderError> {
        let vertex = compile_shader(GL_VERTEX_SHADER, COLOR_VERTEX_SHADER)?;
        let fragment = match compile_shader(GL_FRAGMENT_SHADER, COLOR_FRAGMENT_SHADER) {
            Ok(fragment) => fragment,
            Err(error) => {
                glDeleteShader(vertex);
                return Err(error);
            }
        };
        let program = glCreateProgram();
        if program == 0 {
            glDeleteShader(vertex);
            glDeleteShader(fragment);
            return Err(RenderError::ProgramLink);
        }
        glAttachShader(program, vertex);
        glAttachShader(program, fragment);
        glBindAttribLocation(program, 0, ATTR_COLOR.as_ptr().cast());
        glBindAttribLocation(program, 1, ATTR_POSITION.as_ptr().cast());
        glLinkProgram(program);
        glDeleteShader(vertex);
        glDeleteShader(fragment);
        let mut ok = 0;
        glGetProgramiv(program, GL_LINK_STATUS, &mut ok);
        if ok == 0 {
            glDeleteProgram(program);
            return Err(RenderError::ProgramLink);
        }
        let model = glGetUniformLocation(program, UNIFORM_MODEL.as_ptr().cast());
        let view_proj = glGetUniformLocation(program, UNIFORM_VIEW_PROJ.as_ptr().cast());
        if model < 0 || view_proj < 0 {
            glDeleteProgram(program);
            return Err(RenderError::MissingUniform);
        }
        Ok(Self {
            name: program,
            model,
            view_proj,
        })
    }

    unsafe fn destroy(self) {
        glDeleteProgram(self.name);
    }
}

impl Program {
    unsafe fn create(fragment_source: &[u8]) -> Result<Self, RenderError> {
        let vertex = compile_shader(GL_VERTEX_SHADER, VERTEX_SHADER)?;
        let fragment = match compile_shader(GL_FRAGMENT_SHADER, fragment_source) {
            Ok(fragment) => fragment,
            Err(error) => {
                glDeleteShader(vertex);
                return Err(error);
            }
        };
        let program = glCreateProgram();
        if program == 0 {
            glDeleteShader(vertex);
            glDeleteShader(fragment);
            return Err(RenderError::ProgramLink);
        }
        glAttachShader(program, vertex);
        glAttachShader(program, fragment);
        glBindAttribLocation(program, 0, ATTR_UV.as_ptr().cast());
        glBindAttribLocation(program, 1, ATTR_COLOR.as_ptr().cast());
        glBindAttribLocation(program, 2, ATTR_POSITION.as_ptr().cast());
        glLinkProgram(program);
        glDeleteShader(vertex);
        glDeleteShader(fragment);
        let mut ok = 0;
        glGetProgramiv(program, GL_LINK_STATUS, &mut ok);
        if ok == 0 {
            glDeleteProgram(program);
            return Err(RenderError::ProgramLink);
        }
        let view_proj = glGetUniformLocation(program, UNIFORM_VIEW_PROJ.as_ptr().cast());
        let texture = glGetUniformLocation(program, UNIFORM_TEXTURE.as_ptr().cast());
        if view_proj < 0 || texture < 0 {
            glDeleteProgram(program);
            return Err(RenderError::MissingUniform);
        }
        glUseProgram(program);
        glUniform1i(texture, 0);
        Ok(Self {
            name: program,
            view_proj,
        })
    }

    unsafe fn destroy(self) {
        glDeleteProgram(self.name);
    }
}

unsafe fn compile_shader(kind: GLenum, source: &[u8]) -> Result<GLuint, RenderError> {
    let shader = glCreateShader(kind);
    if shader == 0 {
        return Err(RenderError::ShaderCompile);
    }
    let pointer = source.as_ptr().cast::<c_char>();
    glShaderSource(shader, 1, &pointer, ptr::null());
    glCompileShader(shader);
    let mut ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &mut ok);
    if ok == 0 {
        glDeleteShader(shader);
        Err(RenderError::ShaderCompile)
    } else {
        Ok(shader)
    }
}

unsafe fn clear_errors() {
    for _ in 0..32 {
        if glGetError() == GL_NO_ERROR {
            break;
        }
    }
}

unsafe fn checked_gl() -> Result<(), RenderError> {
    let error = glGetError();
    if error == GL_NO_ERROR {
        Ok(())
    } else {
        Err(RenderError::Gl(error))
    }
}

pub(crate) unsafe fn clear_frame(
    viewport: Viewport,
    clear_color: Option<[f32; 4]>,
    clear_depth: bool,
) -> Result<(), RenderError> {
    clear_errors();
    glViewport(
        viewport.x,
        viewport.y,
        viewport.width as GLsizei,
        viewport.height as GLsizei,
    );
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_BLEND);
    glDisable(GL_CULL_FACE);
    glDisable(GL_DEPTH_TEST);
    // The depth write mask also controls `glClear(GL_DEPTH_BUFFER_BIT)`.
    glDepthMask(GL_TRUE);
    let mut clear_mask = 0;
    if let Some(color) = clear_color {
        glClearColor(color[0], color[1], color[2], color[3]);
        clear_mask |= GL_COLOR_BUFFER_BIT;
    }
    if clear_depth {
        glClearDepthf(1.0);
        clear_mask |= GL_DEPTH_BUFFER_BIT;
    }
    if clear_mask != 0 {
        glClear(clear_mask);
    }
    checked_gl()
}

pub(crate) struct GpuWorld {
    opaque: Program,
    masked: Program,
    vertices: GLuint,
    indices: GLuint,
    textures: Vec<GLuint>,
    max_texture_size: u32,
}

impl GpuWorld {
    pub(crate) unsafe fn new(
        vertices: &[GlesWorldVertex],
        indices: &[u16],
        texture_count: usize,
    ) -> Result<Self, RenderError> {
        let vertex_bytes = vertices
            .len()
            .checked_mul(size_of::<GlesWorldVertex>())
            .ok_or(RenderError::BufferAllocation)?;
        let index_bytes = indices
            .len()
            .checked_mul(size_of::<u16>())
            .ok_or(RenderError::BufferAllocation)?;
        clear_errors();
        let opaque = Program::create(OPAQUE_FRAGMENT_SHADER)?;
        let masked = match Program::create(MASKED_FRAGMENT_SHADER) {
            Ok(program) => program,
            Err(error) => {
                opaque.destroy();
                return Err(error);
            }
        };

        let mut buffers = [0u32; 2];
        glGenBuffers(2, buffers.as_mut_ptr());
        if buffers[0] == 0 || buffers[1] == 0 {
            if buffers[0] != 0 || buffers[1] != 0 {
                glDeleteBuffers(2, buffers.as_ptr());
            }
            opaque.destroy();
            masked.destroy();
            return Err(RenderError::BufferAllocation);
        }
        glBindBuffer(GL_ARRAY_BUFFER, buffers[0]);
        glBufferData(
            GL_ARRAY_BUFFER,
            vertex_bytes as GLsizeiptr,
            vertices.as_ptr().cast(),
            GL_STATIC_DRAW,
        );
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, buffers[1]);
        glBufferData(
            GL_ELEMENT_ARRAY_BUFFER,
            index_bytes as GLsizeiptr,
            indices.as_ptr().cast(),
            GL_STATIC_DRAW,
        );
        glBindBuffer(GL_ARRAY_BUFFER, 0);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);

        let mut maximum = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &mut maximum);
        if maximum <= 0 {
            glDeleteBuffers(2, buffers.as_ptr());
            opaque.destroy();
            masked.destroy();
            return Err(RenderError::BufferAllocation);
        }
        if let Err(error) = checked_gl() {
            glDeleteBuffers(2, buffers.as_ptr());
            opaque.destroy();
            masked.destroy();
            return Err(error);
        }

        Ok(Self {
            opaque,
            masked,
            vertices: buffers[0],
            indices: buffers[1],
            textures: vec![0; texture_count],
            max_texture_size: maximum as u32,
        })
    }

    pub(crate) fn texture_resident(&self, index: usize) -> bool {
        self.textures
            .get(index)
            .is_some_and(|texture| *texture != 0)
    }

    pub(crate) fn texture_count(&self) -> usize {
        self.textures
            .iter()
            .filter(|texture| **texture != 0)
            .count()
    }

    pub(crate) unsafe fn upload_texture(
        &mut self,
        index: usize,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), RenderError> {
        if width > self.max_texture_size || height > self.max_texture_size {
            return Err(RenderError::TextureTooLarge {
                texture: index,
                width,
                height,
                maximum: self.max_texture_size,
            });
        }
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(RenderError::TextureAllocation { texture: index })?;
        if rgba.len() < expected {
            return Err(RenderError::TextureAllocation { texture: index });
        }
        let Some(slot) = self.textures.get_mut(index) else {
            return Err(RenderError::TextureAllocation { texture: index });
        };
        if *slot != 0 {
            return Ok(());
        }

        clear_errors();
        let mut name = 0;
        glGenTextures(1, &mut name);
        if name == 0 {
            return Err(RenderError::TextureAllocation { texture: index });
        }
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, name);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        let wrap = if width.is_power_of_two() && height.is_power_of_two() {
            GL_REPEAT
        } else {
            GL_CLAMP_TO_EDGE
        };
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap);
        glTexImage2D(
            GL_TEXTURE_2D,
            0,
            GL_RGBA as GLint,
            width as GLsizei,
            height as GLsizei,
            0,
            GL_RGBA,
            GL_UNSIGNED_BYTE,
            rgba.as_ptr().cast(),
        );
        glBindTexture(GL_TEXTURE_2D, 0);
        if let Err(error) = checked_gl() {
            glDeleteTextures(1, &name);
            clear_errors();
            return Err(error);
        }
        *slot = name;
        Ok(())
    }

    pub(crate) unsafe fn draw(
        &mut self,
        map: &CookedMap<'_>,
        runs: &[Vec<(u32, u32)>],
        view_proj: &[f32; 16],
        options: FrameOptions,
        counters: &mut WorldCounters,
    ) -> Result<(), RenderError> {
        clear_frame(options.viewport, options.clear_color, options.clear_depth)?;

        glDisable(GL_BLEND);
        glDisable(GL_CULL_FACE);
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LEQUAL);
        glActiveTexture(GL_TEXTURE0);
        glBindBuffer(GL_ARRAY_BUFFER, self.vertices);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self.indices);
        glEnableVertexAttribArray(0);
        glEnableVertexAttribArray(1);
        glEnableVertexAttribArray(2);

        let stride = size_of::<GlesWorldVertex>() as GLsizei;
        let mut bound_texture = 0;
        for masked_pass in [false, true] {
            let program = if masked_pass {
                &self.masked
            } else {
                &self.opaque
            };
            glUseProgram(program.name);
            glUniformMatrix4fv(program.view_proj, 1, GL_FALSE, view_proj.as_ptr());
            for (batch_index, batch) in map.batches.iter().enumerate() {
                if (batch.kind == SurfaceKind::AlphaTest) != masked_pass {
                    continue;
                }
                let batch_runs = &runs[batch_index];
                if batch_runs.is_empty() {
                    continue;
                }
                let texture = self.textures[batch.texture as usize];
                if texture == 0 {
                    counters.skipped_draw_calls += batch_runs.len() as u32;
                    continue;
                }
                if texture != bound_texture {
                    glBindTexture(GL_TEXTURE_2D, texture);
                    bound_texture = texture;
                }
                let base =
                    vertex_buffer_offset(batch.vert_base).ok_or(RenderError::InvalidVertexData)?;
                glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, stride, base as *const c_void);
                glVertexAttribPointer(
                    1,
                    4,
                    GL_UNSIGNED_BYTE,
                    GL_TRUE,
                    stride,
                    (base + 8) as *const c_void,
                );
                glVertexAttribPointer(
                    2,
                    3,
                    GL_FLOAT,
                    GL_FALSE,
                    stride,
                    (base + 12) as *const c_void,
                );
                for &(index_base, index_count) in batch_runs {
                    let index_offset =
                        index_buffer_offset(index_base).ok_or(RenderError::InvalidVertexData)?;
                    glDrawElements(
                        GL_TRIANGLES,
                        index_count as GLsizei,
                        GL_UNSIGNED_SHORT,
                        index_offset as *const c_void,
                    );
                    counters.submitted_triangles += index_count / 3;
                    counters.submitted_draw_calls += 1;
                }
            }
        }

        glDisableVertexAttribArray(0);
        glDisableVertexAttribArray(1);
        glDisableVertexAttribArray(2);
        glBindBuffer(GL_ARRAY_BUFFER, 0);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
        glBindTexture(GL_TEXTURE_2D, 0);
        glDisable(GL_DEPTH_TEST);
        glUseProgram(0);
        checked_gl()
    }

    pub(crate) unsafe fn destroy(self) {
        for texture in self.textures {
            if texture != 0 {
                glDeleteTextures(1, &texture);
            }
        }
        glDeleteBuffers(1, &self.vertices);
        glDeleteBuffers(1, &self.indices);
        self.opaque.destroy();
        self.masked.destroy();
    }
}

pub(crate) struct DynamicGpu {
    program: ColorProgram,
    buffer: GLuint,
    capacity: usize,
}

impl DynamicGpu {
    pub(crate) unsafe fn new() -> Result<Self, RenderError> {
        clear_errors();
        let program = ColorProgram::create()?;
        let mut buffer = 0;
        glGenBuffers(1, &mut buffer);
        if buffer == 0 {
            program.destroy();
            return Err(RenderError::BufferAllocation);
        }
        if let Err(error) = checked_gl() {
            glDeleteBuffers(1, &buffer);
            program.destroy();
            return Err(error);
        }
        Ok(Self {
            program,
            buffer,
            capacity: 0,
        })
    }

    pub(crate) fn buffer_capacity(&self) -> usize {
        self.capacity
    }

    pub(crate) unsafe fn draw_color_tris(
        &mut self,
        vertices: &[ColorVertex],
        model: &[f32; 16],
        view_proj: &[f32; 16],
        mode: BlendMode,
    ) -> Result<(), RenderError> {
        if vertices.is_empty() {
            return Ok(());
        }
        let required = vertices
            .len()
            .checked_mul(size_of::<ColorVertex>())
            .filter(|bytes| *bytes <= isize::MAX as usize)
            .ok_or(RenderError::BufferAllocation)?;

        clear_errors();
        glBindBuffer(GL_ARRAY_BUFFER, self.buffer);
        if required > self.capacity {
            let capacity = required
                .max(4096)
                .checked_next_power_of_two()
                .filter(|bytes| *bytes <= isize::MAX as usize)
                .ok_or(RenderError::BufferAllocation)?;
            glBufferData(
                GL_ARRAY_BUFFER,
                capacity as GLsizeiptr,
                ptr::null(),
                GL_DYNAMIC_DRAW,
            );
            if let Err(error) = checked_gl() {
                glBindBuffer(GL_ARRAY_BUFFER, 0);
                return Err(error);
            }
            self.capacity = capacity;
        }
        glBufferSubData(
            GL_ARRAY_BUFFER,
            0,
            required as GLsizeiptr,
            vertices.as_ptr().cast(),
        );
        if let Err(error) = checked_gl() {
            glBindBuffer(GL_ARRAY_BUFFER, 0);
            return Err(error);
        }

        glDisable(GL_SCISSOR_TEST);
        glDisable(GL_CULL_FACE);
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LEQUAL);
        match mode {
            BlendMode::Opaque => {
                glDisable(GL_BLEND);
                glDepthMask(GL_TRUE);
            }
            BlendMode::Additive => {
                glEnable(GL_BLEND);
                glBlendFunc(GL_SRC_ALPHA, GL_ONE);
                glDepthMask(GL_FALSE);
            }
        }

        glUseProgram(self.program.name);
        glUniformMatrix4fv(self.program.model, 1, GL_FALSE, model.as_ptr());
        glUniformMatrix4fv(self.program.view_proj, 1, GL_FALSE, view_proj.as_ptr());
        let stride = size_of::<ColorVertex>() as GLsizei;
        glEnableVertexAttribArray(0);
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(0, 4, GL_UNSIGNED_BYTE, GL_TRUE, stride, ptr::null());
        glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, stride, 4usize as *const c_void);
        glDrawArrays(GL_TRIANGLES, 0, vertices.len() as GLsizei);

        glDisableVertexAttribArray(0);
        glDisableVertexAttribArray(1);
        glDepthMask(GL_TRUE);
        glDisable(GL_BLEND);
        glDisable(GL_DEPTH_TEST);
        glBindBuffer(GL_ARRAY_BUFFER, 0);
        glUseProgram(0);
        checked_gl()
    }

    pub(crate) unsafe fn clear_depth_for_viewmodel(&mut self) -> Result<(), RenderError> {
        clear_errors();
        glDisable(GL_SCISSOR_TEST);
        glDepthMask(GL_TRUE);
        glClearDepthf(1.0);
        glClear(GL_DEPTH_BUFFER_BIT);
        checked_gl()
    }

    pub(crate) unsafe fn destroy(self) {
        glDeleteBuffers(1, &self.buffer);
        self.program.destroy();
    }
}
