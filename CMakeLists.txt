cmake_minimum_required(VERSION 3.10)

project(MoonlightWasm VERSION 1.0)

add_compile_options(-w -s WASM=1 -fno-ident -O2 -flto -DSAMSUNG_WRT -DOS_WASM -DNDEBUG)

add_library(moonlight-rs STATIC
    moonlight-common-c/reedsolomon/rs.c)
target_include_directories(moonlight-rs PUBLIC
    moonlight-common-c/reedsolomon)
target_compile_features(moonlight-rs PUBLIC c_std_99)

add_library(moonlight-enet STATIC
    moonlight-common-c/enet/callbacks.c
    moonlight-common-c/enet/compress.c
    moonlight-common-c/enet/host.c
    moonlight-common-c/enet/list.c
    moonlight-common-c/enet/packet.c
    moonlight-common-c/enet/peer.c
    moonlight-common-c/enet/protocol.c
    moonlight-common-c/enet/unix.c
    moonlight-common-c/enet/win32.c
)
target_compile_definitions(moonlight-enet PUBLIC
    LC_CHROME
    HAS_SOCKLEN_T=1
    HAS_FCNTL=1
    NO_MSGAPI=1)
target_include_directories(moonlight-enet PUBLIC
    moonlight-common-c/enet/include)

add_library(moonlight-common-c STATIC
    moonlight-common-c/src/AudioStream.c
    moonlight-common-c/src/ByteBuffer.c
    moonlight-common-c/src/Connection.c
    moonlight-common-c/src/ConnectionTester.c
    moonlight-common-c/src/ControlStream.c
    moonlight-common-c/src/FakeCallbacks.c
    moonlight-common-c/src/InputStream.c
    moonlight-common-c/src/LinkedBlockingQueue.c
    moonlight-common-c/src/Misc.c
    moonlight-common-c/src/Platform.c
    moonlight-common-c/src/PlatformCrypto.c
    moonlight-common-c/src/PlatformSockets.c
    moonlight-common-c/src/RecorderCallbacks.c
    moonlight-common-c/src/RtpAudioQueue.c
    moonlight-common-c/src/RtpVideoQueue.c
    moonlight-common-c/src/RtspConnection.c
    moonlight-common-c/src/RtspParser.c
    moonlight-common-c/src/SdpGenerator.c
    moonlight-common-c/src/SimpleStun.c
    moonlight-common-c/src/VideoDepacketizer.c
    moonlight-common-c/src/VideoStream.c
)
target_compile_definitions(moonlight-common-c PUBLIC
    LC_CHROME)
target_include_directories(moonlight-common-c PUBLIC
    moonlight-common-c/src
    moonlight-common-c/enet/include
    moonlight-common-c/reedsolomon)
target_compile_features(moonlight-common-c PUBLIC c_std_99)
set_target_properties(moonlight-common-c
    PROPERTIES
        COMPILE_FLAGS
            "-s USE_CRYPTO=1 -s USE_SSL=1")

add_library(libgamestream STATIC
    libgamestream/http.c
    libgamestream/mkcert.c
    libgamestream/pairing.c
)
target_include_directories(libgamestream PUBLIC
    libgamestream)
set_target_properties(libgamestream
    PROPERTIES
        COMPILE_FLAGS
            "-s USE_CRYPTO=1 -s USE_SSL=1 -s USE_CURL=1")

# The decoder of Opus (the app only decodes): the files of the encoder are left out. Every file here is one that the
# decoder links (opus_multistream_decoder_create(), opus_multistream_decode()); tests/native/run.sh builds this list
# and decodes with it.
add_library(opus STATIC
    opus/celt/bands.c
    opus/celt/celt.c
    opus/celt/celt_decoder.c
    opus/celt/celt_lpc.c
    opus/celt/cwrs.c
    opus/celt/entcode.c
    opus/celt/entdec.c
    opus/celt/entenc.c
    opus/celt/kiss_fft.c
    opus/celt/laplace.c
    opus/celt/mathops.c
    opus/celt/mdct.c
    opus/celt/modes.c
    opus/celt/pitch.c
    opus/celt/quant_bands.c
    opus/celt/rate.c
    opus/celt/vq.c
    opus/silk/bwexpander_32.c
    opus/silk/bwexpander.c
    opus/silk/CNG.c
    opus/silk/code_signs.c
    opus/silk/dec_API.c
    opus/silk/decode_core.c
    opus/silk/decode_frame.c
    opus/silk/decode_indices.c
    opus/silk/decode_parameters.c
    opus/silk/decode_pitch.c
    opus/silk/decode_pulses.c
    opus/silk/decoder_set_fs.c
    opus/silk/gain_quant.c
    opus/silk/init_decoder.c
    opus/silk/lin2log.c
    opus/silk/log2lin.c
    opus/silk/LPC_analysis_filter.c
    opus/silk/LPC_fit.c
    opus/silk/LPC_inv_pred_gain.c
    opus/silk/NLSF2A.c
    opus/silk/NLSF_decode.c
    opus/silk/NLSF_stabilize.c
    opus/silk/NLSF_unpack.c
    opus/silk/pitch_est_tables.c
    opus/silk/PLC.c
    opus/silk/resampler.c
    opus/silk/resampler_private_AR2.c
    opus/silk/resampler_private_down_FIR.c
    opus/silk/resampler_private_IIR_FIR.c
    opus/silk/resampler_private_up2_HQ.c
    opus/silk/resampler_rom.c
    opus/silk/shell_coder.c
    opus/silk/sort.c
    opus/silk/stereo_decode_pred.c
    opus/silk/stereo_MS_to_LR.c
    opus/silk/sum_sqr_shift.c
    opus/silk/table_LSF_cos.c
    opus/silk/tables_gain.c
    opus/silk/tables_LTP.c
    opus/silk/tables_NLSF_CB_NB_MB.c
    opus/silk/tables_NLSF_CB_WB.c
    opus/silk/tables_other.c
    opus/silk/tables_pitch_lag.c
    opus/silk/tables_pulses_per_block.c
    opus/src/opus.c
    opus/src/opus_decoder.c
    opus/src/opus_multistream.c
    opus/src/opus_multistream_decoder.c
)
target_include_directories(opus PUBLIC
    opus/include
    opus/src
    opus/silk
    opus/celt
    opus/silk/fixed)
target_compile_definitions(opus PUBLIC
     USE_ALLOCA
     HAVE_LRINT
     HAVE_LRINTF
     FIXED_POINT
     OPUS_BUILD)

add_executable(moonlight-wasm
    wasm/libchelper.c
    wasm/auddec.cpp
    wasm/connectionlistener.cpp
    wasm/gamepad.cpp
    wasm/http.cpp
    wasm/input.cpp
    wasm/main.cpp
    wasm/wasmplayer.cpp
)
target_include_directories(moonlight-wasm PUBLIC
    wasm
    wasm/dispatcher
    moonlight-common-c/src
    moonlight-common-c/enet/include
    moonlight-common-c/reedsolomon
    libgamestream
    opus/include
    opus/src
    opus/silk
    opus/silk/fixed
    opus/celt
)
set_target_properties(moonlight-wasm
    PROPERTIES
        COMPILE_FLAGS
            "-s USE_CRYPTO=1 -s USE_SSL=1 -s USE_CURL=1")
target_compile_features(moonlight-wasm PUBLIC cxx_std_17)
set_target_properties(moonlight-wasm
    PROPERTIES
        LINK_FLAGS
            "--bind \
             -pthread \
             -O2 \
             -flto \
             -s TOTAL_MEMORY=134217728 \
             -s TOTAL_STACK=16777216 \
             -s NO_EXIT_RUNTIME=1 \
             -s USE_PTHREADS=1 \
             -s PTHREAD_POOL_SIZE=20 \
             -s WASM=1 \
             -s ENVIRONMENT_MAY_BE_TIZEN \
             -s USE_CRYPTO=1 \
             -s USE_SSL=1 \
             -s USE_CURL=1")
target_link_libraries(moonlight-wasm PUBLIC
    libgamestream
    opus
    moonlight-common-c
    moonlight-enet
    moonlight-rs
)

set(EMSCRIPTEN_OUTPUT_FILES
  "${CMAKE_CURRENT_BINARY_DIR}/moonlight-wasm.js.mem"
  "${CMAKE_CURRENT_BINARY_DIR}/moonlight-wasm.wasm"
  "${CMAKE_CURRENT_BINARY_DIR}/moonlight-wasm.worker.js"
)

install(TARGETS moonlight-wasm RUNTIME DESTINATION widget)
install(FILES ${EMSCRIPTEN_OUTPUT_FILES} DESTINATION widget OPTIONAL)
# en-US.json only lists the source texts for the tools and the translators (the app needs no dictionary for English),
# and i18n-sync.js is a Node tool for the developers: neither goes into the widget
install(DIRECTORY wasm/static DESTINATION widget
    PATTERN "en-US.json" EXCLUDE
    PATTERN "i18n-sync.js" EXCLUDE)
install(DIRECTORY wasm/platform DESTINATION widget)
install(DIRECTORY res/service DESTINATION widget)
install(FILES wasm/index.html DESTINATION widget)
install(FILES res/config.xml DESTINATION widget)
install(FILES res/platform.js DESTINATION widget)
