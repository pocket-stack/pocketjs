#include <libusb.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
    NokiaVendorId = 0x0421,
    NokiaE7SuiteProductId = 0x0335,
    CodaControlInterface = 3,
    CodaDataInterface = 4,
    TransferTimeoutMs = 3000,
    TransferSliceMs = 250,
    ResponseCapacity = 16384,
};

static int is_bulk_endpoint(
    const struct libusb_endpoint_descriptor *endpoint,
    int direction
) {
    return (endpoint->bmAttributes & LIBUSB_TRANSFER_TYPE_MASK) ==
            LIBUSB_TRANSFER_TYPE_BULK &&
        (endpoint->bEndpointAddress & LIBUSB_ENDPOINT_DIR_MASK) == direction;
}

static int find_coda_endpoints(
    libusb_device *device,
    uint8_t *endpoint_in,
    uint8_t *endpoint_out,
    int *alternate_setting
) {
    struct libusb_config_descriptor *config = NULL;
    int result = libusb_get_active_config_descriptor(device, &config);
    if (result != LIBUSB_SUCCESS)
        return result;

    for (uint8_t index = 0; index < config->bNumInterfaces; ++index) {
        const struct libusb_interface *interface = &config->interface[index];
        for (int alt = 0; alt < interface->num_altsetting; ++alt) {
            const struct libusb_interface_descriptor *descriptor =
                &interface->altsetting[alt];
            if (descriptor->bInterfaceNumber != CodaDataInterface)
                continue;
            uint8_t candidate_in = 0;
            uint8_t candidate_out = 0;
            for (uint8_t endpoint_index = 0;
                 endpoint_index < descriptor->bNumEndpoints;
                 ++endpoint_index) {
                const struct libusb_endpoint_descriptor *endpoint =
                    &descriptor->endpoint[endpoint_index];
                if (is_bulk_endpoint(endpoint, LIBUSB_ENDPOINT_IN))
                    candidate_in = endpoint->bEndpointAddress;
                else if (is_bulk_endpoint(endpoint, LIBUSB_ENDPOINT_OUT))
                    candidate_out = endpoint->bEndpointAddress;
            }
            if (candidate_in != 0 && candidate_out != 0) {
                *endpoint_in = candidate_in;
                *endpoint_out = candidate_out;
                *alternate_setting = descriptor->bAlternateSetting;
                libusb_free_config_descriptor(config);
                return LIBUSB_SUCCESS;
            }
        }
    }

    libusb_free_config_descriptor(config);
    return LIBUSB_ERROR_NOT_FOUND;
}

static int claim_interface(
    libusb_device_handle *handle,
    int interface,
    int *detached
) {
    *detached = 0;
    const int active = libusb_kernel_driver_active(handle, interface);
    if (active == 1) {
        const int detach_result =
            libusb_detach_kernel_driver(handle, interface);
        if (detach_result == LIBUSB_SUCCESS) {
            *detached = 1;
        } else if (detach_result != LIBUSB_ERROR_NOT_SUPPORTED) {
            return detach_result;
        }
    }
    const int result = libusb_claim_interface(handle, interface);
    if (result != LIBUSB_SUCCESS && *detached) {
        libusb_attach_kernel_driver(handle, interface);
        *detached = 0;
    }
    return result;
}

static int set_cdc_control_state(libusb_device_handle *handle) {
    static const unsigned char line_coding[] = {
        0x00, 0xc2, 0x01, 0x00, /* 115200, little endian */
        0x00,                   /* one stop bit */
        0x00,                   /* no parity */
        0x08,                   /* eight data bits */
    };
    int result = libusb_control_transfer(
        handle,
        LIBUSB_ENDPOINT_OUT | LIBUSB_REQUEST_TYPE_CLASS |
            LIBUSB_RECIPIENT_INTERFACE,
        0x20, /* SET_LINE_CODING */
        0,
        CodaControlInterface,
        (unsigned char *)line_coding,
        sizeof(line_coding),
        TransferTimeoutMs
    );
    if (result < 0 && result != LIBUSB_ERROR_PIPE)
        return result;

    result = libusb_control_transfer(
        handle,
        LIBUSB_ENDPOINT_OUT | LIBUSB_REQUEST_TYPE_CLASS |
            LIBUSB_RECIPIENT_INTERFACE,
        0x22, /* SET_CONTROL_LINE_STATE */
        0x0003,
        CodaControlInterface,
        NULL,
        0,
        TransferTimeoutMs
    );
    return result < 0 && result != LIBUSB_ERROR_PIPE
        ? result
        : LIBUSB_SUCCESS;
}

static int find_pong(
    const unsigned char *buffer,
    int length,
    char *version,
    size_t version_capacity
) {
    for (int offset = 0; offset + 6 <= length; ++offset) {
        if (buffer[offset] != 0x01 || buffer[offset + 1] != 0x92)
            continue;
        const int payload_length =
            ((int)buffer[offset + 2] << 8) | buffer[offset + 3];
        if (payload_length < 2 || offset + 4 + payload_length > length)
            continue;
        const unsigned char *payload = buffer + offset + 4;
        if (payload[0] != 0xfc || payload[1] != 0xf1)
            continue;
        const int available = payload_length - 2;
        const size_t copy_length = available < (int)version_capacity - 1
            ? (size_t)available
            : version_capacity - 1;
        size_t written = 0;
        for (size_t index = 0; index < copy_length; ++index) {
            const unsigned char value = payload[index + 2];
            if (value >= 0x20 && value <= 0x7e)
                version[written++] = (char)value;
        }
        version[written] = '\0';
        return 1;
    }
    return 0;
}

static int find_locator_hello(const unsigned char *buffer, int length) {
    static const unsigned char locator_prefix[] = {
        'E', 0x00,
        'L', 'o', 'c', 'a', 't', 'o', 'r', 0x00,
        'H', 'e', 'l', 'l', 'o', 0x00,
    };
    for (int offset = 0; offset + 4 + (int)sizeof(locator_prefix) <= length;
         ++offset) {
        if (buffer[offset] != 0x01 || buffer[offset + 1] != 0x92)
            continue;
        const int payload_length =
            ((int)buffer[offset + 2] << 8) | buffer[offset + 3];
        if (payload_length < (int)sizeof(locator_prefix) ||
            offset + 4 + payload_length > length) {
            continue;
        }
        if (memcmp(
                buffer + offset + 4,
                locator_prefix,
                sizeof(locator_prefix)
            ) == 0) {
            return 1;
        }
    }
    return 0;
}

typedef int (*response_matcher)(
    const unsigned char *buffer,
    int length,
    void *context
);

struct pong_context {
    char *version;
    size_t version_capacity;
};

static int match_pong(
    const unsigned char *buffer,
    int length,
    void *context
) {
    struct pong_context *pong = context;
    return find_pong(
        buffer,
        length,
        pong->version,
        pong->version_capacity
    );
}

static int match_locator(
    const unsigned char *buffer,
    int length,
    void *context
) {
    (void)context;
    return find_locator_hello(buffer, length);
}

/*
 * USB bulk reads are a byte stream: one router frame may be fragmented across
 * transfers, and several frames may arrive together. Keep a bounded
 * accumulator and match complete frames against a single total timeout.
 */
static int read_until(
    libusb_device_handle *handle,
    uint8_t endpoint,
    unsigned char *buffer,
    int capacity,
    int *length,
    response_matcher matcher,
    void *context
) {
    if (matcher(buffer, *length, context))
        return LIBUSB_SUCCESS;

    int remaining = TransferTimeoutMs;
    while (remaining > 0) {
        if (*length >= capacity)
            return LIBUSB_ERROR_OVERFLOW;

        const int timeout = remaining < TransferSliceMs
            ? remaining
            : TransferSliceMs;
        int transferred = 0;
        const int result = libusb_bulk_transfer(
            handle,
            endpoint,
            buffer + *length,
            capacity - *length,
            &transferred,
            (unsigned int)timeout
        );
        if (transferred > 0) {
            *length += transferred;
            if (matcher(buffer, *length, context))
                return LIBUSB_SUCCESS;
        }
        if (result != LIBUSB_SUCCESS && result != LIBUSB_ERROR_TIMEOUT)
            return result;
        remaining -= timeout;
    }
    return LIBUSB_ERROR_TIMEOUT;
}

int main(void) {
    libusb_context *context = NULL;
    libusb_device **devices = NULL;
    libusb_device *match = NULL;
    libusb_device_handle *handle = NULL;
    uint8_t endpoint_in = 0;
    uint8_t endpoint_out = 0;
    int alternate_setting = 0;
    int control_claimed = 0;
    int data_claimed = 0;
    int control_detached = 0;
    int data_detached = 0;
    int exit_code = 1;

    int result = libusb_init(&context);
    if (result != LIBUSB_SUCCESS) {
        fprintf(stderr, "CODA USB: libusb initialization failed\n");
        return 1;
    }

    const ssize_t count = libusb_get_device_list(context, &devices);
    if (count < 0) {
        fprintf(stderr, "CODA USB: device enumeration failed\n");
        goto cleanup;
    }

    int matches = 0;
    for (ssize_t index = 0; index < count; ++index) {
        struct libusb_device_descriptor descriptor;
        if (libusb_get_device_descriptor(devices[index], &descriptor) !=
            LIBUSB_SUCCESS) {
            continue;
        }
        if (descriptor.idVendor == NokiaVendorId &&
            descriptor.idProduct == NokiaE7SuiteProductId) {
            match = devices[index];
            ++matches;
        }
    }
    if (matches != 1) {
        fprintf(
            stderr,
            "CODA USB: expected exactly one Nokia E7 in Suite mode, found %d\n",
            matches
        );
        goto cleanup;
    }

    result = find_coda_endpoints(
        match,
        &endpoint_in,
        &endpoint_out,
        &alternate_setting
    );
    if (result != LIBUSB_SUCCESS) {
        fprintf(stderr, "CODA USB: interface 4 bulk endpoints are unavailable\n");
        goto cleanup;
    }

    result = libusb_open(match, &handle);
    if (result != LIBUSB_SUCCESS) {
        fprintf(stderr, "CODA USB: unable to open the E7 USB device\n");
        goto cleanup;
    }

    result = claim_interface(
        handle,
        CodaControlInterface,
        &control_detached
    );
    if (result == LIBUSB_SUCCESS)
        control_claimed = 1;
    else if (result != LIBUSB_ERROR_BUSY &&
             result != LIBUSB_ERROR_NOT_SUPPORTED) {
        fprintf(stderr, "CODA USB: unable to claim control interface 3\n");
        goto cleanup;
    }

    result = claim_interface(handle, CodaDataInterface, &data_detached);
    if (result != LIBUSB_SUCCESS) {
        fprintf(
            stderr,
            "CODA USB: unable to claim data interface 4 (%s)\n",
            libusb_error_name(result)
        );
        goto cleanup;
    }
    data_claimed = 1;

    if (alternate_setting != 0) {
        result = libusb_set_interface_alt_setting(
            handle,
            CodaDataInterface,
            alternate_setting
        );
        if (result != LIBUSB_SUCCESS) {
            fprintf(stderr, "CODA USB: unable to select the data interface\n");
            goto cleanup;
        }
    }

    if (control_claimed) {
        result = set_cdc_control_state(handle);
        if (result != LIBUSB_SUCCESS) {
            fprintf(stderr, "CODA USB: unable to initialize the control channel\n");
            goto cleanup;
        }
    }

    static const unsigned char ping[] = {
        0x01, 0x92, 0x00, 0x02, 0xfc, 0x1f,
    };
    int transferred = 0;
    result = libusb_bulk_transfer(
        handle,
        endpoint_out,
        (unsigned char *)ping,
        sizeof(ping),
        &transferred,
        TransferTimeoutMs
    );
    if (result != LIBUSB_SUCCESS || transferred != (int)sizeof(ping)) {
        fprintf(stderr, "CODA USB: ping write failed\n");
        goto cleanup;
    }

    unsigned char response[ResponseCapacity];
    int response_length = 0;
    char version[256];
    struct pong_context pong = {
        .version = version,
        .version_capacity = sizeof(version),
    };
    result = read_until(
        handle,
        endpoint_in,
        response,
        sizeof(response),
        &response_length,
        match_pong,
        &pong
    );
    if (result != LIBUSB_SUCCESS) {
        fprintf(
            stderr,
            "CODA USB: no pong received (%s)\n",
            libusb_error_name(result)
        );
        goto cleanup;
    }

    static const unsigned char locator_answer[] =
        "E\0Locator\0Hello\0[\"Locator\"]";
    const size_t locator_length = sizeof(locator_answer);
    unsigned char locator_frame[4 + sizeof(locator_answer)];
    locator_frame[0] = 0x01;
    locator_frame[1] = 0x92;
    locator_frame[2] = (unsigned char)(locator_length >> 8);
    locator_frame[3] = (unsigned char)(locator_length & 0xff);
    memcpy(locator_frame + 4, locator_answer, locator_length);

    transferred = 0;
    result = libusb_bulk_transfer(
        handle,
        endpoint_out,
        locator_frame,
        sizeof(locator_frame),
        &transferred,
        TransferTimeoutMs
    );
    if (result != LIBUSB_SUCCESS ||
        transferred != (int)sizeof(locator_frame)) {
        fprintf(stderr, "CODA USB: Locator hello write failed\n");
        goto cleanup;
    }

    result = read_until(
        handle,
        endpoint_in,
        response,
        sizeof(response),
        &response_length,
        match_locator,
        NULL
    );
    if (result != LIBUSB_SUCCESS) {
        fprintf(stderr, "CODA USB: Locator handshake failed\n");
        goto cleanup;
    }

    printf("CODA USB: ready\n");
    if (version[0] != '\0')
        printf("CODA version: %s\n", version);
    printf("CODA Locator: ready\n");
    exit_code = 0;

cleanup:
    if (data_claimed)
        libusb_release_interface(handle, CodaDataInterface);
    if (control_claimed)
        libusb_release_interface(handle, CodaControlInterface);
    if (data_detached)
        libusb_attach_kernel_driver(handle, CodaDataInterface);
    if (control_detached)
        libusb_attach_kernel_driver(handle, CodaControlInterface);
    if (handle != NULL)
        libusb_close(handle);
    if (devices != NULL)
        libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return exit_code;
}
