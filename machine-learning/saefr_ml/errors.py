class ServiceError(Exception):
    """Only an allowlisted code may cross the HTTP boundary."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code
